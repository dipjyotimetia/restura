#!/usr/bin/env node
// Check a worktree agent's final report against git instead of trusting it.
//
// /batch-ship workers end with a fixed JSON report (branch, worktree, sha,
// filesTouched, redFirst, gates). The orchestrator used to re-verify those
// claims by hand; this makes the checks mechanical so a failed claim goes back
// to the worker with a concrete error:
//   - the report parses and has every field; no gate is reported failing
//   - the sha exists and is the branch tip
//   - every file the branch changed is inside the files the plan assigned it
//   - filesTouched matches what git says changed (no phantom/unclaimed files)
//   - with --red-first: the reported test command FAILS on the base with only
//     the branch's test files applied (proves the test detects the bug)
//
// Usage:
//   node scripts/verify-agent-report.mjs <report.json|-> --owned <p1,p2,...>
//     [--base origin/main] [--red-first]
// Owned entries: exact paths, `dir/` prefixes, or globs (`*`, `**`).
// Exit 0 = all checks passed; 1 = problems (printed as JSON); 2 = usage error.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setupWorktree } from './worktree-setup.mjs';

const REQUIRED = ['branch', 'worktree', 'sha', 'filesTouched', 'redFirst', 'gates'];

/** Parse the report from bare JSON or the last ```json fence in agent prose. */
export function extractReport(text) {
  const candidates = [text.trim()];
  for (const m of text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)) candidates.unshift(m[1]);
  for (const c of candidates) {
    try {
      const value = JSON.parse(c);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      // try next candidate
    }
  }
  return null;
}

export function validateReport(report) {
  const problems = [];
  for (const key of REQUIRED) if (report[key] == null) problems.push(`missing field: ${key}`);
  if (report.sha != null && !/^[0-9a-f]{40}$/.test(report.sha))
    problems.push('sha must be a full 40-char commit sha');
  if (report.filesTouched != null && !Array.isArray(report.filesTouched))
    problems.push('filesTouched must be an array');
  if (report.redFirst != null) {
    // Any non-object (false, '', 0, 'yes') must fail loudly, never skip the check.
    const rf = typeof report.redFirst === 'object' ? report.redFirst : {};
    if (typeof rf.command !== 'string' || !rf.command.trim())
      problems.push('redFirst.command is empty');
    if (typeof rf.failingExcerpt !== 'string' || !rf.failingExcerpt.trim())
      problems.push('redFirst.failingExcerpt is empty — red-first was not shown');
  }
  for (const [gate, result] of Object.entries(report.gates ?? {})) {
    if (result !== 'pass') problems.push(`gate ${gate} reported "${result}"`);
  }
  return problems;
}

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      i++;
      // `**/` = zero or more whole directories; a bare `**` = anything.
      if (glob[i + 1] === '/') {
        re += '(?:.*/)?';
        i++;
      } else re += '.*';
    } else if (ch === '*') re += '[^/]*';
    else re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function filesOutsideOwnership(files, owned) {
  const matchers = owned.map((o) => {
    if (o.includes('*')) {
      const re = globToRegExp(o);
      return (f) => re.test(f);
    }
    if (o.endsWith('/')) return (f) => f.startsWith(o);
    return (f) => f === o;
  });
  return files.filter((f) => !matchers.some((m) => m(f)));
}

export function compareClaimed(claimed, actual) {
  const c = new Set(claimed);
  const a = new Set(actual);
  return { unclaimed: actual.filter((f) => !c.has(f)), phantom: claimed.filter((f) => !a.has(f)) };
}

const RUNNER_FAILURE =
  /(\bFAIL\b|\bfailed\b|^not ok\b|^# fail [1-9]|[×✖✗]|AssertionError|ERR_MODULE_NOT_FOUND|Cannot find module)/m;
const NOT_A_TEST_RUN =
  /(command not found|Missing script|ENOENT: no such file or directory, (?:open|scandir) '[^']*package\.json'|No test files found)/;

/** Decide whether a red-first run failed *as a test* (null) or for another reason (problem text). */
export function classifyRedRun({ status, output }) {
  if (status === null) return 'red-first run timed out or was killed — not a test failure';
  if (status === 0)
    return 'red-first command PASSED on the base with only the tests applied — the test does not detect the bug';
  if (NOT_A_TEST_RUN.test(output))
    return `red-first command failed but not a test failure: ${output.trim().split('\n').slice(-2).join(' | ').slice(0, 200)}`;
  if (!RUNNER_FAILURE.test(output))
    return 'red-first command exited non-zero but printed no test-runner failure';
  return null;
}

export function isTestPath(p) {
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) ||
    /(^|\/)__tests__\//.test(p) ||
    /^tests\//.test(p) ||
    /^e2e(-electron)?\//.test(p)
  );
}

function parseArgs(argv) {
  const opts = { report: null, owned: null, base: 'origin/main', redFirst: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--owned') opts.owned = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--base') opts.base = argv[++i];
    else if (a === '--red-first') opts.redFirst = true;
    else if (!opts.report) opts.report = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  if (!opts.report || !opts.owned?.length)
    throw new Error(
      'usage: verify-agent-report <report.json|-> --owned <paths> [--base ref] [--red-first]'
    );
  return opts;
}

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (args, cwd) => {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
};

function runRedFirst(report, base, repo, testFiles) {
  if (testFiles.length === 0) return ['red-first: the branch changes no test files'];
  const mergeBase = git(['merge-base', base, report.sha], repo);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restura-redfirst-'));
  try {
    git(['worktree', 'add', '--detach', dir, mergeBase], repo);
    git(['checkout', report.sha, '--', ...testFiles], dir);
    // Keep stdout pure JSON: worktree:setup narrates via console.log.
    const log = console.log;
    console.log = console.error;
    try {
      setupWorktree(dir);
    } finally {
      console.log = log;
    }
    // The command string comes from agent output: it only ever runs here, in a
    // throwaway worktree, and the orchestrator should read it before --red-first.
    const run = spawnSync(report.redFirst.command, {
      cwd: dir,
      shell: true,
      encoding: 'utf8',
      timeout: 600_000,
    });
    const problem = classifyRedRun({
      status: run.status,
      output: `${run.stdout ?? ''}\n${run.stderr ?? ''}`,
    });
    return problem ? [`red-first: ${problem}`] : [];
  } finally {
    tryGit(['worktree', 'remove', '--force', dir], repo);
  }
}

export function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  const text =
    opts.report === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(opts.report, 'utf8');
  const report = extractReport(text);
  if (!report) {
    console.log(JSON.stringify({ ok: false, problems: ['no JSON report found'] }, null, 2));
    return 1;
  }
  const problems = validateReport(report);
  const repo = git(['rev-parse', '--show-toplevel'], process.cwd());
  if (
    report.sha &&
    !tryGit(['cat-file', '-e', `${report.sha}^{commit}`], repo) &&
    tryGit(['cat-file', '-t', report.sha], repo) !== 'commit'
  ) {
    problems.push(`sha ${report.sha} does not exist`);
  } else if (report.sha) {
    const tip = tryGit(['rev-parse', `refs/heads/${report.branch}`], repo);
    if (tip !== report.sha)
      problems.push(
        `branch ${report.branch} tip is ${tip ?? '(missing)'}, report says ${report.sha}`
      );
    // --no-renames: moving someone else's file must show its deletion too.
    const diffNames = (...extra) =>
      git(['diff', '--name-only', '--no-renames', ...extra, `${opts.base}...${report.sha}`], repo)
        .split('\n')
        .filter(Boolean);
    const actual = diffNames();
    const outside = filesOutsideOwnership(actual, opts.owned);
    if (outside.length) problems.push(`changed files outside ownership: ${outside.join(', ')}`);
    const { unclaimed, phantom } = compareClaimed(report.filesTouched ?? [], actual);
    if (unclaimed.length) problems.push(`changed but not reported: ${unclaimed.join(', ')}`);
    if (phantom.length) problems.push(`reported but not changed: ${phantom.join(', ')}`);
    if (
      opts.redFirst &&
      typeof report.redFirst?.command === 'string' &&
      report.redFirst.command.trim()
    )
      problems.push(
        ...runRedFirst(report, opts.base, repo, diffNames('--diff-filter=AM').filter(isTestPath))
      );
  }
  console.log(
    JSON.stringify(
      { ok: problems.length === 0, branch: report.branch, sha: report.sha, problems },
      null,
      2
    )
  );
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main();
