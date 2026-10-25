#!/usr/bin/env node
// Build-loop capability eval: does the main agent loop (CLAUDE.md + skills)
// produce correct, parity-complete FIXES?
//
// SWE-bench style. Each task under evals/build/tasks/ is a real fix PR: the
// agent gets a history-free repo at the fix commit's first parent (`base`,
// so the fix is unreachable) with the harness under test overlaid, and the
// bug written up like a GitHub issue. When it finishes, the fix commit's
// tests (`hiddenTests`) are copied in from `referenceCommit`, overwriting any
// agent version, and the task's `failToPass` + `passToPass` commands grade
// the OUTCOME STATE. Code graders only: the agent's claims are never read.
// Transcripts that reach outside the isolated repo are excluded as errors.
//
// --dry-run is the validator (no model calls): for each task the hidden tests
// must FAIL on base (they detect the bug), and with the reference diff applied
// every failToPass and passToPass command must PASS (the task is solvable and
// the graders work). Every committed task must pass it.
//
// Usage:
//   node scripts/build-eval.mjs [--case <id>]... [--split train|test|all] [--runs N]
//     [--config <label>] [--harness-ref <ref>] [--model <model>]
//     [--max-budget-usd <n>] [--out <dir>] [--dry-run]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import {
  createIsolatedRepo,
  detectContamination,
  killLiveChildren,
  linkNodeModules,
  nodeExec,
  parseClaudeStream,
  passAtK,
  passHatK,
  redactSecrets,
  syncExec,
  wilsonInterval,
} from './harness-eval.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TASKS_DIR = path.join(ROOT, 'evals/build/tasks');
export const DEFAULT_OUT = '.claude/metrics/evals/build';
export const PROMPT_SUFFIX =
  'Fix this in the repository following its CLAUDE.md workflow. Commit your work. Do not push or open PRs.';

const TEMP_PREFIX = 'restura-build-eval-';
const SPLITS = ['train', 'test'];
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const CONFIG_RE = /^[A-Za-z0-9._-]+$/;
const DEFAULT_COMMAND_TIMEOUT_MINUTES = 20;
const TAIL_CHARS = 2000;
const TEST_COMMAND_RE =
  /\b(vitest|test:run|test:tooling|node --test|playwright|npm (run )?test|npm run validate)\b/;
const TYPECHECK_ALL_RE = /\btype-check:all\b/;
const COMMIT_RE = /\bgit\b[^|;&\n]*\bcommit\b/;
/** The reference diff never carries node_modules (a stray committed symlink would collide with the links). */
const DIFF_EXCLUDES = [':(exclude,glob)**/node_modules'];
/** Paths stripped from every isolated repo: the answer keys (task files) must never be in reach. */
export const ANSWER_KEY_PATHS = ['evals'];

const IDENTITY = ['-c', 'user.name=restura-build-eval', '-c', 'user.email=build-eval@localhost'];

// ---------------------------------------------------------------- arguments

export function parseBuildArgs(argv) {
  const options = {
    caseIds: [],
    split: 'all',
    runs: 2,
    harnessRef: 'HEAD',
    config: 'current',
    model: undefined,
    maxBudgetUsd: 15,
    out: DEFAULT_OUT,
    dryRun: false,
  };
  const valued = [
    '--case',
    '--split',
    '--runs',
    '--harness-ref',
    '--config',
    '--model',
    '--max-budget-usd',
    '--out',
  ];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const name = arg.split('=')[0];
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (!valued.includes(name)) throw new Error(`Unknown option: ${arg}`);
    let value;
    if (arg.startsWith(`${name}=`)) value = arg.slice(name.length + 1);
    else {
      value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
      index += 1;
    }
    if (name === '--case') options.caseIds.push(value);
    else if (name === '--split') {
      if (![...SPLITS, 'all'].includes(value))
        throw new Error('--split must be train, test or all');
      options.split = value;
    } else if (name === '--runs') {
      const runs = Number(value);
      if (!Number.isInteger(runs) || runs < 1 || runs > 20)
        throw new Error('--runs must be an integer from 1 to 20');
      options.runs = runs;
    } else if (name === '--harness-ref') {
      if (value.startsWith('-') || /\s/.test(value))
        throw new Error('--harness-ref must be a git ref or commit');
      options.harnessRef = value;
    } else if (name === '--config') {
      if (!CONFIG_RE.test(value)) throw new Error('--config must match [A-Za-z0-9._-]+');
      options.config = value;
    } else if (name === '--model') options.model = value;
    else if (name === '--out') options.out = value;
    else {
      const budget = Number(value);
      if (!(budget > 0)) throw new Error('--max-budget-usd must be a positive number');
      options.maxBudgetUsd = budget;
    }
  }
  return options;
}

// ---------------------------------------------------------------- tasks

const isStringList = (v) =>
  Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim() !== '');

/**
 * Validate one parsed task file. Reports every problem, not just the first.
 * `check` reaches git: resolveCommit(sha), existsAt(sha, path), firstParent(sha).
 * @param {any} raw
 * @param {{ resolveCommit: (sha: string) => boolean; existsAt: (sha: string, p: string) => boolean;
 *   firstParent: (sha: string) => string | null }} check
 */
export function validateTask(raw, check) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['task is not a mapping'] };
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) errors.push('id must be kebab-case');
  if (typeof raw.title !== 'string' || raw.title.trim() === '') errors.push('title is required');
  if (!SPLITS.includes(raw.split)) errors.push(`split must be one of ${SPLITS.join('|')}`);
  for (const key of ['base', 'referenceCommit'])
    if (typeof raw[key] !== 'string' || !SHA_RE.test(raw[key]))
      errors.push(`${key} must be a full 40-character commit SHA`);
  if (typeof raw.issue !== 'string' || raw.issue.trim() === '') errors.push('issue is required');
  if (!(isStringList(raw.hiddenTests) && raw.hiddenTests.length > 0))
    errors.push('hiddenTests must list at least one repo path');
  if (!(isStringList(raw.failToPass) && raw.failToPass.length > 0))
    errors.push('failToPass must list at least one command');
  if (!isStringList(raw.passToPass)) errors.push('passToPass must be a list of commands');
  if (!(Number.isFinite(raw.timeoutMinutes) && raw.timeoutMinutes > 0))
    errors.push('timeoutMinutes must be a positive number');
  if (
    raw.commandTimeoutMinutes !== undefined &&
    !(Number.isFinite(raw.commandTimeoutMinutes) && raw.commandTimeoutMinutes > 0)
  )
    errors.push('commandTimeoutMinutes must be a positive number');
  if (raw.notes !== undefined && typeof raw.notes !== 'string')
    errors.push('notes must be a string');
  // Extra terms (fix symbols, module names) that must not appear in the harness overlay.
  if (raw.leakTerms !== undefined && !isStringList(raw.leakTerms))
    errors.push('leakTerms must be a list of non-empty strings');

  const hidden = isStringList(raw.hiddenTests) ? raw.hiddenTests : [];
  for (const p of hidden)
    if (path.isAbsolute(p) || p.split('/').includes('..') || p.startsWith('.git/'))
      errors.push(`hiddenTests: ${p} must be a relative repo path`);
  // The issue is all the agent sees: it must never point at the answer key.
  if (typeof raw.issue === 'string') {
    for (const p of hidden) {
      const base = path.posix.basename(p);
      const stem = base.replace(/\.[^.]+$/, '');
      if ([p, base, stem].some((needle) => needle && raw.issue.includes(needle)))
        errors.push(`issue must not name hidden test ${p}`);
    }
    if (
      typeof raw.referenceCommit === 'string' &&
      raw.issue.includes(raw.referenceCommit.slice(0, 7))
    )
      errors.push('issue must not cite the reference commit');
  }

  const shasOk = errors.every((e) => !/SHA/.test(e));
  if (shasOk) {
    for (const key of ['base', 'referenceCommit'])
      if (!check.resolveCommit(raw[key])) errors.push(`${key} ${raw[key]} does not resolve`);
    if (check.resolveCommit(raw.referenceCommit)) {
      const parent = check.firstParent(raw.referenceCommit);
      if (parent !== raw.base)
        errors.push(`base must be the first parent of referenceCommit (${parent ?? 'none'})`);
      for (const p of hidden)
        if (!check.existsAt(raw.referenceCommit, p))
          errors.push(`hiddenTests: ${p} is not in referenceCommit`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    value: {
      ...raw,
      issue: raw.issue.trim(),
      passToPass: raw.passToPass,
      commandTimeoutMinutes: raw.commandTimeoutMinutes ?? DEFAULT_COMMAND_TIMEOUT_MINUTES,
      leakTerms: raw.leakTerms ?? [],
      notes: raw.notes ?? '',
    },
  };
}

/** Git-backed checks against `repo` (synchronous; used at load time). */
export function gitChecks(repo, exec = syncExec) {
  const ok = (args) => exec.run('git', ['-C', repo, ...args]).status === 0;
  return {
    resolveCommit: (sha) => ok(['cat-file', '-e', `${sha}^{commit}`]),
    existsAt: (sha, p) => ok(['cat-file', '-e', `${sha}:${p}`]),
    firstParent: (sha) => {
      const r = exec.run('git', ['-C', repo, 'rev-parse', '--verify', '-q', `${sha}^1`]);
      return r.status === 0 ? r.stdout.trim() : null;
    },
  };
}

/**
 * @param {{ dir?: string; ids?: string[]; split?: string;
 *   check?: ReturnType<typeof gitChecks> }} [options]
 */
export function loadTasks({ dir = TASKS_DIR, ids = [], split = 'all', check = undefined } = {}) {
  const checks = check ?? gitChecks(ROOT);
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.yaml'))
    .sort();
  const all = [];
  const problems = [];
  for (const file of files) {
    const result = validateTask(loadYaml(fs.readFileSync(path.join(dir, file), 'utf8')), checks);
    if (!result.ok) problems.push(`${file}:\n  - ${result.errors.join('\n  - ')}`);
    else if (`${result.value.id}.yaml` !== file)
      problems.push(`${file}: id ${result.value.id} must match the file name`);
    else all.push(result.value);
  }
  if (problems.length > 0) throw new Error(`Invalid build-eval tasks:\n${problems.join('\n')}`);
  const inSplit = split === 'all' ? all : all.filter((t) => t.split === split);
  if (ids.length === 0) return inSplit;
  const unknown = ids.filter((id) => !all.some((t) => t.id === id));
  if (unknown.length > 0) throw new Error(`Unknown task(s): ${unknown.join(', ')}`);
  const outside = ids.filter((id) => !inSplit.some((t) => t.id === id));
  if (outside.length > 0) throw new Error(`Task(s) not in split ${split}: ${outside.join(', ')}`);
  return inSplit.filter((t) => ids.includes(t.id));
}

// ---------------------------------------------------------------- agent

export function buildAgentPrompt(task) {
  return `${task.issue.trim()}\n\n${PROMPT_SUFFIX}`;
}

/** @param {{ model?: string; maxBudgetUsd?: number }} options */
export function buildAgentArgs({ model, maxBudgetUsd = 15 }) {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--permission-mode',
    'dontAsk',
    '--max-budget-usd',
    String(maxBudgetUsd),
  ];
  if (model) args.push('--model', model);
  args.push(
    '--allowedTools',
    'Bash',
    'Read',
    'Edit',
    'Write',
    'Grep',
    'Glob',
    'Skill',
    'Task',
    '--disallowedTools',
    'Bash(git push:*)',
    'Bash(gh:*)',
    'Bash(curl:*)',
    'Bash(wget:*)',
    'WebFetch',
    'WebSearch'
  );
  return args;
}

/**
 * Process metrics from a stream-json transcript (works without a result
 * event, e.g. a timed-out run): turns, cost, minutes, tool/skill/agent use,
 * and verification habits (did it run type-check:all, any tests, a commit).
 */
export function transcriptMetrics(stdout) {
  const metrics = {
    turns: null,
    costUsd: null,
    minutes: null,
    subtype: null,
    toolStats: { toolCalls: 0, skills: [], agents: [] },
    ranTypeCheckAll: false,
    ranTests: false,
    ranCommit: false,
  };
  for (const line of String(stdout ?? '').split('\n')) {
    let event;
    try {
      event = JSON.parse(line.trim());
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'result') {
      if (typeof event.num_turns === 'number') metrics.turns = event.num_turns;
      if (typeof event.total_cost_usd === 'number') metrics.costUsd = event.total_cost_usd;
      if (typeof event.duration_ms === 'number') metrics.minutes = event.duration_ms / 60000;
      if (typeof event.subtype === 'string') metrics.subtype = event.subtype;
    }
    const content = event.type === 'assistant' ? event.message?.content : null;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_use') continue;
      metrics.toolStats.toolCalls += 1;
      const input = block.input ?? {};
      if (block.name === 'Skill' && typeof input.skill === 'string')
        metrics.toolStats.skills.push(input.skill);
      if (
        (block.name === 'Task' || block.name === 'Agent') &&
        typeof input.subagent_type === 'string'
      )
        metrics.toolStats.agents.push(input.subagent_type);
      if (block.name === 'Bash' && typeof input.command === 'string') {
        if (TYPECHECK_ALL_RE.test(input.command)) metrics.ranTypeCheckAll = true;
        if (TEST_COMMAND_RE.test(input.command)) metrics.ranTests = true;
        if (COMMIT_RE.test(input.command)) metrics.ranCommit = true;
      }
    }
  }
  return metrics;
}

/**
 * Fail closed: a run is graded only when claude exited 0 with a parseable
 * stream, at least one turn and no error, or when it stopped on max turns
 * (graded on the outcome state). Anything else (non-zero exit, a timeout kill,
 * zero turns, unparseable output, is_error or any other error subtype such as
 * a budget stop) is a harness ERROR, excluded from scoring.
 */
export function classifyAgentRun(raw) {
  const stderr = String(raw.stderr ?? '').trim();
  if (raw.signal || /timed out after \d+ ms/.test(stderr))
    return { graded: false, reason: `agent killed (${raw.signal ?? 'timeout'})` };
  if (raw.status !== 0)
    return { graded: false, reason: `claude exited ${raw.status}: ${stderr.split('\n')[0] ?? ''}` };
  let parsed;
  try {
    parsed = parseClaudeStream(raw.stdout);
  } catch (error) {
    return { graded: false, reason: `unparseable stream (${error.message.slice(0, 120)})` };
  }
  if (parsed.subtype === 'error_max_turns')
    return { graded: true, parsed, stopped: 'max turns reached' };
  if (!(parsed.numTurns > 0)) return { graded: false, reason: 'zero turns', parsed };
  if (parsed.isError || parsed.subtype?.startsWith('error'))
    return { graded: false, reason: `claude ended with ${parsed.subtype ?? 'is_error'}`, parsed };
  return { graded: true, parsed };
}

// ---------------------------------------------------------------- grading

const tail = (text) => (text.length > TAIL_CHARS ? text.slice(-TAIL_CHARS) : text);

/** Run one grader command (a shell string from a committed task file) in the repo. */
export async function runCommand(exec, command, { cwd, timeoutMs }) {
  const started = Date.now();
  const result = await exec.run('bash', ['-c', command], {
    cwd,
    timeout: timeoutMs,
    env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  const output = `${result.stdout ?? ''}${result.stderr ? `\n${result.stderr}` : ''}`;
  const timedOut = Boolean(result.signal) || /timed out after \d+ ms/.test(result.stderr ?? '');
  return {
    command,
    status: result.status === 0 && !result.signal ? 'pass' : timedOut ? 'timeout' : 'fail',
    exitCode: result.status ?? null,
    ms: Date.now() - started,
    tail: tail(redactSecrets(output.trim())),
  };
}

/** `pass` only when every failToPass and passToPass command passes; partial = fraction passing. */
export function gradeCommands({ failToPass, passToPass }) {
  const all = [...failToPass, ...passToPass];
  if (all.length === 0) return { outcome: 'fail', partial: 0 };
  const passed = all.filter((r) => r.status === 'pass').length;
  return { outcome: passed === all.length ? 'pass' : 'fail', partial: passed / all.length };
}

/** Copy each hidden test from `ref` (read from `repo`) into `dir`, overwriting the agent's version. */
export async function applyHiddenTests(exec, { repo, dir, ref, paths }) {
  for (const p of paths) {
    const shown = await exec.run('git', ['-C', repo, 'show', `${ref}:${p}`]);
    if (shown.status !== 0)
      throw new Error(`hidden test ${p}: ${(shown.stderr || shown.stdout || '').trim()}`);
    const target = path.join(dir, p);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.rmSync(target, { force: true });
    fs.writeFileSync(target, shown.stdout);
  }
}

/** Undo applyHiddenTests (dry run): restore the base version or remove the file. */
async function restoreHiddenTests(exec, { dir, paths }) {
  for (const p of paths) {
    const atHead = await exec.run('git', ['-C', dir, 'cat-file', '-e', `HEAD:${p}`]);
    if (atHead.status === 0) {
      const restored = await exec.run('git', ['-C', dir, 'checkout', 'HEAD', '--', p]);
      if (restored.status !== 0) throw new Error(`restore ${p}: ${restored.stderr}`);
    } else fs.rmSync(path.join(dir, p), { force: true });
  }
}

/** Apply the reference fix (base..ref, read from `repo`) to the isolated repo's working tree. */
export async function applyReferenceDiff(exec, { repo, dir, base, ref }) {
  const result = await exec.pipe(
    ['git', ['-C', repo, 'diff', '--binary', base, ref, '--', '.', ...DIFF_EXCLUDES]],
    ['git', ['-C', dir, 'apply', '--whitespace=nowarn']]
  );
  if (result.status !== 0)
    throw new Error(`reference diff: ${(result.stderr || result.stdout || '').trim()}`);
}

/** The validator's decision for one task. */
export function dryRunVerdict({ atBase, atReference }) {
  const problems = [];
  for (const r of atBase)
    if (r.status === 'pass')
      problems.push(`failToPass passes on base (does not detect the bug): ${r.command}`);
  for (const r of atReference.failToPass)
    if (r.status !== 'pass')
      problems.push(`failToPass ${r.status} with the reference fix: ${r.command}`);
  for (const r of atReference.passToPass)
    if (r.status !== 'pass')
      problems.push(`passToPass ${r.status} with the reference fix: ${r.command}`);
  return { ok: problems.length === 0, problems };
}

async function runGraders(exec, task, dir) {
  const timeoutMs = task.commandTimeoutMinutes * 60 * 1000;
  const run = async (commands) => {
    const out = [];
    for (const command of commands)
      out.push(await runCommand(exec, command, { cwd: dir, timeoutMs }));
    return out;
  };
  return { failToPass: await run(task.failToPass), passToPass: await run(task.passToPass) };
}

/**
 * Remove the answer keys (ANSWER_KEY_PATHS: evals/ holds the task files) from
 * the isolated repo, amending the overlay commit so no reachable tree has them,
 * and repoint main / origin/main. Returns the new effective base.
 */
async function stripAnswerKeys(exec, dir, effectiveBase) {
  const present = ANSWER_KEY_PATHS.filter((p) => fs.existsSync(path.join(dir, p)));
  if (present.length === 0) return effectiveBase;
  const git = async (args, what) => {
    const r = await exec.run('git', ['-C', dir, ...args]);
    if (r.status !== 0)
      throw new Error(`strip answer keys: ${what}: ${(r.stderr || r.stdout || '').trim()}`);
    return r;
  };
  await git(['rm', '-r', '-q', '--ignore-unmatch', '--', ...present], 'rm');
  for (const p of present) fs.rmSync(path.join(dir, p), { recursive: true, force: true });
  await git(
    [...IDENTITY, 'commit', '-q', '--no-verify', '--amend', '--no-edit', '--allow-empty'],
    'amend'
  );
  const head = (await git(['rev-parse', 'HEAD'], 'rev-parse')).stdout.trim();
  await git(['update-ref', 'refs/heads/main', head], 'main');
  await git(['update-ref', 'refs/remotes/origin/main', head], 'origin/main');
  return head;
}

/**
 * One trial of one task in a fresh isolated repo under `ctx.tempDir` (the
 * caller removes it). Real runs: agent → contamination check → hidden tests
 * copied in → graders. Dry runs: hidden tests on base must fail; with the
 * reference diff everything must pass.
 * @param {any} task validated task
 * @param {{ exec: { run: Function; pipe: Function }; repo: string; tempDir: string; harnessSha: string;
 *   dryRun?: boolean; mainCheckout?: string; forbiddenRoots?: string[]; model?: string; maxBudgetUsd?: number;
 *   transcriptFile?: string; transcriptLink?: string; setup?: (dir: string) => void;
 *   createRepo?: typeof createIsolatedRepo }} ctx
 */
export async function runTask(task, ctx) {
  const { exec, repo, tempDir } = ctx;
  const dir = path.join(tempDir, 'repo');
  const outcome = { taskId: task.id, split: task.split, status: 'ok' };
  try {
    const { effectiveBase } = await (ctx.createRepo ?? createIsolatedRepo)(exec, {
      dir,
      baseSha: task.base,
      harnessSha: ctx.harnessSha,
      repo,
    });
    outcome.harnessSha = ctx.harnessSha;
    outcome.effectiveBase = await stripAnswerKeys(exec, dir, effectiveBase);
    // A hidden test that exists at base keeps base's version until grading overwrites it.
    outcome.hiddenTestsAtBase = task.hiddenTests.filter((p) => fs.existsSync(path.join(dir, p)));
    (ctx.setup ?? ((d) => linkNodeModules(d, ctx.mainCheckout ?? repo)))(dir);
    const hidden = { repo, dir, ref: task.referenceCommit, paths: task.hiddenTests };

    if (ctx.dryRun) {
      await applyHiddenTests(exec, hidden);
      const timeoutMs = task.commandTimeoutMinutes * 60 * 1000;
      const atBase = [];
      for (const command of task.failToPass)
        atBase.push(await runCommand(exec, command, { cwd: dir, timeoutMs }));
      await restoreHiddenTests(exec, { dir, paths: task.hiddenTests });
      await applyReferenceDiff(exec, { repo, dir, base: task.base, ref: task.referenceCommit });
      await applyHiddenTests(exec, hidden);
      const atReference = await runGraders(exec, task, dir);
      const verdict = dryRunVerdict({ atBase, atReference });
      outcome.dryRun = { ...verdict, atBase, atReference };
      if (!verdict.ok) {
        outcome.status = 'error';
        outcome.reason = verdict.problems.join('; ');
      }
      return outcome;
    }

    const raw = await exec.run('claude', buildAgentArgs(ctx), {
      cwd: dir,
      input: buildAgentPrompt(task),
      timeout: task.timeoutMinutes * 60 * 1000,
    });
    if (ctx.transcriptFile) {
      fs.mkdirSync(path.dirname(ctx.transcriptFile), { recursive: true });
      fs.writeFileSync(ctx.transcriptFile, redactSecrets(raw.stdout ?? ''));
      outcome.transcript = ctx.transcriptLink ?? ctx.transcriptFile;
    }
    outcome.agent = transcriptMetrics(raw.stdout);
    const classified = classifyAgentRun(raw);
    if (!classified.graded) throw new Error(`agent: ${classified.reason}`);
    if (classified.stopped) outcome.agentStopped = classified.stopped;
    if (classified.parsed.permissionDenials.length > 0)
      outcome.permissionDenials = classified.parsed.permissionDenials.length;
    if (ctx.forbiddenRoots?.length) {
      let real = dir;
      try {
        real = fs.realpathSync(dir);
      } catch {}
      const contamination = detectContamination(raw.stdout, {
        forbiddenRoots: ctx.forbiddenRoots,
        isolatedRoot: [dir, real],
      });
      if (contamination.contaminated) {
        outcome.contamination = contamination.hits;
        throw new Error(
          `contaminated: ${contamination.hits.length} tool call(s) reached outside the isolated repo (${contamination.hits.map((h) => h.tool).join(', ')})`
        );
      }
    }
    const count = await exec.run('git', [
      '-C',
      dir,
      'rev-list',
      '--count',
      `${outcome.effectiveBase}..HEAD`,
    ]);
    outcome.commits = count.status === 0 ? Number(count.stdout.trim()) || 0 : null;
    outcome.committed = (outcome.commits ?? 0) > 0;
    const status = await exec.run('git', ['-C', dir, 'status', '--porcelain']);
    outcome.uncommittedChanges = status.status === 0 ? status.stdout.trim() !== '' : null;

    await applyHiddenTests(exec, hidden);
    outcome.commands = await runGraders(exec, task, dir);
    Object.assign(outcome, gradeCommands(outcome.commands));
    return outcome;
  } catch (error) {
    outcome.status = 'error';
    outcome.reason = error instanceof Error ? error.message : String(error);
    outcome.outcome = null;
    return outcome;
  }
}

// ---------------------------------------------------------------- summary

const mean = (values) =>
  values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
const numbers = (values) => values.filter((v) => typeof v === 'number');
const rate = (runs, pick) => (runs.length === 0 ? null : runs.filter(pick).length / runs.length);

function aggregate(runs) {
  const scored = runs.filter((r) => r.status === 'ok');
  const passes = scored.filter((r) => r.outcome === 'pass').length;
  const n = scored.length;
  return {
    runs: runs.length,
    scored: n,
    errors: runs.length - n,
    passes,
    pass1: passAtK(n, passes, 1),
    passHatN: passHatK(n, passes, n),
    meanPartial: mean(numbers(scored.map((r) => r.partial))),
    meanCostUsd: mean(numbers(runs.map((r) => r.agent?.costUsd))),
    meanMinutes: mean(numbers(runs.map((r) => r.agent?.minutes))),
    typeCheckAllRate: rate(scored, (r) => r.agent?.ranTypeCheckAll),
    testsRate: rate(scored, (r) => r.agent?.ranTests),
    commitRate: rate(scored, (r) => r.committed),
  };
}

/** Per-task pass@1 / pass^n (n = scored trials) and totals with a Wilson 95% CI. Errors are excluded. */
export function summariseBuild(runs) {
  const byTask = {};
  for (const id of [...new Set(runs.map((r) => r.taskId))])
    byTask[id] = {
      split: runs.find((r) => r.taskId === id)?.split ?? null,
      ...aggregate(runs.filter((r) => r.taskId === id)),
    };
  const totalsFor = (subset) => {
    const a = aggregate(subset);
    return {
      ...a,
      pass1: a.scored > 0 ? a.passes / a.scored : null,
      ci: wilsonInterval(a.passes, a.scored),
      totalCostUsd: numbers(subset.map((r) => r.agent?.costUsd)).reduce((x, y) => x + y, 0),
    };
  };
  const bySplit = {};
  for (const split of SPLITS) {
    const subset = runs.filter((r) => r.split === split);
    if (subset.length > 0) bySplit[split] = totalsFor(subset);
  }
  return { byTask, bySplit, totals: totalsFor(runs) };
}

const pct = (v) => (typeof v === 'number' ? `${(v * 100).toFixed(0)}%` : '–');
const usd = (v) => (typeof v === 'number' ? `$${v.toFixed(2)}` : '–');
const mins = (v) => (typeof v === 'number' ? v.toFixed(1) : '–');

export function formatBuildMarkdown(result) {
  const s = result.summary;
  const lines = [
    `# Build eval ${result.dryRun ? '(dry run) ' : ''}— config \`${result.config}\``,
    '',
    `Harness ${String(result.harnessSha ?? '').slice(0, 12)}; model ${result.model ?? 'default'}; ${result.runsPerTask ?? '?'} run(s) per task.`,
    '',
  ];
  if (result.dryRun) {
    lines.push('| task | split | validator | problems |', '|---|---|---|---|');
    for (const r of result.runs)
      lines.push(
        `| ${r.taskId} | ${r.split} | ${r.status === 'ok' ? 'ok' : 'FAIL'} | ${(r.reason ?? '').replace(/\|/g, '\\|').slice(0, 300)} |`
      );
    return `${lines.join('\n')}\n`;
  }
  lines.push(
    '| task | split | scored | errors | pass@1 | pass^n | partial | type-check:all | tests | committed | cost | min |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|'
  );
  for (const [id, t] of Object.entries(s.byTask))
    lines.push(
      `| ${id} | ${t.split} | ${t.scored} | ${t.errors} | ${pct(t.pass1)} | ${pct(t.passHatN)} | ${pct(t.meanPartial)} | ${pct(t.typeCheckAllRate)} | ${pct(t.testsRate)} | ${pct(t.commitRate)} | ${usd(t.meanCostUsd)} | ${mins(t.meanMinutes)} |`
    );
  lines.push('');
  const total = (label, t) =>
    `- **${label}**: pass@1 ${pct(t.pass1)} (${t.passes}/${t.scored}${t.ci ? `, 95% CI ${pct(t.ci.low)}–${pct(t.ci.high)}` : ''}), mean partial ${pct(t.meanPartial)}, ${t.errors} error(s) excluded, cost ${usd(t.totalCostUsd)}`;
  lines.push(total('all', s.totals));
  for (const [split, t] of Object.entries(s.bySplit)) lines.push(total(split, t));
  const errors = result.runs.filter((r) => r.status === 'error');
  if (errors.length > 0) {
    lines.push('', '## Errors (excluded)', '');
    for (const r of errors) lines.push(`- ${r.taskId} run ${r.run ?? '?'}: ${r.reason}`);
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------- main

export async function runBuildEval(options, { exec = nodeExec, log = console.log } = {}) {
  const repo = (
    await exec.run('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT })
  ).stdout.trim();
  const commonDir = (
    await exec.run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: ROOT,
    })
  ).stdout.trim();
  const mainCheckout = commonDir ? path.dirname(commonDir) : repo;
  const forbiddenRoots = [
    ...new Set(
      [mainCheckout, repo].flatMap((p) => {
        try {
          return [p, fs.realpathSync(p)];
        } catch {
          return [p];
        }
      })
    ),
  ];
  const tasks = loadTasks({ ids: options.caseIds, split: options.split, check: gitChecks(repo) });
  const resolved = await exec.run(
    'git',
    ['rev-parse', '--verify', `${options.harnessRef}^{commit}`],
    {
      cwd: ROOT,
    }
  );
  const harnessSha = resolved.stdout.trim();
  if (resolved.status !== 0 || !SHA_RE.test(harnessSha))
    throw new Error(`--harness-ref ${options.harnessRef} does not resolve to a commit`);
  const runs = options.dryRun ? 1 : options.runs;
  const startedAt = new Date().toISOString();
  const outDir = path.resolve(ROOT, options.out);
  const base = path.join(
    outDir,
    `${startedAt.replace(/[:.]/g, '-')}${options.dryRun ? '--dry-run' : ''}--${options.config}`
  );
  const result = {
    config: options.config,
    startedAt,
    dryRun: options.dryRun,
    harnessRef: options.harnessRef,
    harnessSha,
    model: options.model ?? null,
    maxBudgetUsd: options.maxBudgetUsd,
    split: options.split,
    runsPerTask: runs,
    runs: [],
  };

  let tempDir = null;
  const onSignal = (signal) => {
    killLiveChildren();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    console.error(`\nbuild-eval: ${signal}; removed this run's isolated repo.`);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    log(
      `${options.dryRun ? 'Validating' : 'Running'} ${tasks.length} task(s) x ${runs} run(s), harness ${harnessSha.slice(0, 12)} (${options.harnessRef}).`
    );
    for (const task of tasks) {
      for (let run = 1; run <= runs; run += 1) {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${TEMP_PREFIX}${task.id}-`));
        log(`${task.id} run ${run}/${runs}…`);
        const name = `${task.id}-run${run}.jsonl`;
        let outcome;
        try {
          outcome = await runTask(task, {
            exec,
            repo,
            tempDir,
            harnessSha,
            dryRun: options.dryRun,
            mainCheckout,
            forbiddenRoots,
            model: options.model,
            maxBudgetUsd: options.maxBudgetUsd,
            transcriptFile: options.dryRun ? undefined : path.join(base, 'transcripts', name),
            transcriptLink: `${path.basename(base)}/transcripts/${name}`,
          });
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
          tempDir = null;
        }
        result.runs.push({ run, ...outcome });
        log(
          outcome.status === 'error'
            ? `  ${options.dryRun ? 'INVALID' : 'error'}: ${outcome.reason}`
            : options.dryRun
              ? '  valid: hidden tests fail on base, pass with the reference fix'
              : `  ${outcome.outcome} (partial ${pct(outcome.partial)})${outcome.agentStopped ? `; agent stopped: ${outcome.agentStopped}` : ''}`
        );
      }
    }
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
  result.summary = summariseBuild(result.runs);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(`${base}.json`, redactSecrets(`${JSON.stringify(result, null, 2)}\n`));
  const markdown = redactSecrets(formatBuildMarkdown(result));
  fs.writeFileSync(`${base}.md`, markdown);
  log(`\n${markdown}`);
  log(`Wrote ${base}.json and ${base}.md`);
  return { result, failed: result.runs.some((r) => r.status === 'error') };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const { failed } = await runBuildEval(parseBuildArgs(process.argv.slice(2)));
    process.exitCode = failed ? 1 : 0;
  } catch (error) {
    console.error(`build-eval: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
