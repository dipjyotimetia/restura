#!/usr/bin/env node
// Harness eval: does the review pipeline catch SEAM bugs?
//
// Each case under evals/harness/cases/ is a real (or labelled synthetic)
// incident where PRs were green alone but broken together, or where one
// harness (web Worker / Electron / CLI) was left unwired. A run rebuilds the
// branch(es) from patch fixtures in a throwaway worktree, asks the review
// entry point (`/ship-check <branches>`) to review them via `claude -p`, and
// grades the final answer twice: deterministic `mustMention` regexes and an
// LLM rubric judge (evals/harness/rubric.md). Results land in --out as one
// JSON per invocation plus a markdown summary, with a flip report against the
// previous invocation of the same --config.
//
// Usage:
//   npm run eval:harness -- [--case <id>]... [--runs N] [--config <label>]
//     [--dry-run] [--out <dir>] [--no-judge] [--max-budget-usd <n>]
//     [--judge-model <model>] [--compare <result.json>]
//
// --dry-run validates every case and applies its patches (plus the combined
// merge) in throwaway worktrees without calling any model.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { setupWorktree } from './worktree-setup.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CASES_DIR = path.join(ROOT, 'evals/harness/cases');
export const FIXTURES_DIR = path.join(ROOT, 'evals/harness/fixtures');
export const RUBRIC_PATH = path.join(ROOT, 'evals/harness/rubric.md');

const ORIGINS = ['real', 'synthetic'];
const SEAMS = ['cross-branch', 'cross-harness', 'cross-consumer'];
const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const CONFIG_RE = /^[A-Za-z0-9._-]+$/;
const REVIEW_TIMEOUT_MS = 90 * 60 * 1000;
const JUDGE_TIMEOUT_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------- arguments

export function parseEvalArgs(argv) {
  const options = {
    caseIds: [],
    runs: 2,
    config: 'current',
    dryRun: false,
    out: '.claude/metrics/evals',
    judge: true,
    judgeModel: undefined,
    maxBudgetUsd: 20,
    compare: undefined,
  };
  const valueOf = (arg, index, name) => {
    if (arg.startsWith(`${name}=`)) return { value: arg.slice(name.length + 1), next: index };
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
    return { value, next: index + 1 };
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const name = arg.split('=')[0];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--no-judge') options.judge = false;
    else if (
      [
        '--case',
        '--runs',
        '--config',
        '--out',
        '--judge-model',
        '--max-budget-usd',
        '--compare',
      ].includes(name)
    ) {
      const { value, next } = valueOf(arg, index, name);
      index = next;
      if (name === '--case') options.caseIds.push(value);
      else if (name === '--runs') {
        const runs = Number(value);
        if (!Number.isInteger(runs) || runs < 1 || runs > 20)
          throw new Error('--runs must be an integer from 1 to 20');
        options.runs = runs;
      } else if (name === '--config') {
        if (!CONFIG_RE.test(value)) throw new Error('--config must match [A-Za-z0-9._-]+');
        options.config = value;
      } else if (name === '--out') options.out = value;
      else if (name === '--judge-model') options.judgeModel = value;
      else if (name === '--compare') options.compare = value;
      else {
        const budget = Number(value);
        if (!(budget > 0)) throw new Error('--max-budget-usd must be a positive number');
        options.maxBudgetUsd = budget;
      }
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

// ---------------------------------------------------------------- case schema

const isStringArray = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/**
 * Validate one parsed case file. Reports every problem, not just the first.
 * @param {any} raw
 * @param {{ fileExists: (p: string) => boolean; fixturesDir?: string }} env
 */
export function validateCase(raw, { fileExists, fixturesDir = FIXTURES_DIR }) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['case is not a mapping'] };
  const id = raw.id;
  if (typeof id !== 'string' || !ID_RE.test(id)) errors.push('id must be kebab-case');
  if (typeof raw.title !== 'string' || raw.title.trim() === '') errors.push('title is required');
  if (!ORIGINS.includes(raw.origin)) errors.push(`origin must be one of ${ORIGINS.join('|')}`);
  if (raw.sourcePRs !== undefined && !isStringArray(raw.sourcePRs))
    errors.push('sourcePRs must be a list of strings');
  if (raw.origin === 'real' && !(isStringArray(raw.sourcePRs) && raw.sourcePRs.length > 0))
    errors.push('real cases must cite sourcePRs');
  if (raw.fixPRs !== undefined && !isStringArray(raw.fixPRs))
    errors.push('fixPRs must be a list of strings');
  if (typeof raw.base !== 'string' || !SHA_RE.test(raw.base))
    errors.push('base must be a full 40-character commit SHA');
  if (!SEAMS.includes(raw.seam)) errors.push(`seam must be one of ${SEAMS.join('|')}`);
  if (!SEVERITIES.includes(raw.mustNotMiss))
    errors.push(`mustNotMiss must be one of ${SEVERITIES.join('|')}`);

  const caseDir = path.join(fixturesDir, typeof id === 'string' ? id : '_');
  const branches = [];
  if (!Array.isArray(raw.branches) || raw.branches.length === 0 || raw.branches.length > 3) {
    errors.push('branches must list 1-3 branches');
  } else {
    const seen = new Set();
    for (const [index, branch] of raw.branches.entries()) {
      const where = `branches[${index}]`;
      if (typeof branch?.name !== 'string' || !BRANCH_RE.test(branch.name)) {
        errors.push(`${where}.name is not a valid branch name`);
        continue;
      }
      if (seen.has(branch.name)) errors.push(`${where}: duplicate branch name ${branch.name}`);
      seen.add(branch.name);
      if (!isStringArray(branch.patches) || branch.patches.length === 0) {
        errors.push(`${where}.patches must list at least one patch file`);
        continue;
      }
      const patchPaths = [];
      for (const patch of branch.patches) {
        const resolved = path.resolve(caseDir, patch);
        if (!resolved.startsWith(`${caseDir}${path.sep}`)) {
          errors.push(`${where}: patch ${patch} must live inside the case fixture dir`);
          continue;
        }
        if (!fileExists(resolved)) errors.push(`${where}: missing patch file ${patch}`);
        patchPaths.push(resolved);
      }
      branches.push({ name: branch.name, patches: branch.patches, patchPaths });
    }
  }

  const expected = raw.expected ?? {};
  if (typeof expected.defect !== 'string' || expected.defect.trim() === '')
    errors.push('expected.defect is required');
  if (!(isStringArray(expected.files) && expected.files.length > 0))
    errors.push('expected.files must name at least one file a correct review must cite');
  if (expected.symbols !== undefined && !isStringArray(expected.symbols))
    errors.push('expected.symbols must be a list of strings');

  if (!(isStringArray(raw.mustMention) && raw.mustMention.length > 0)) {
    errors.push('mustMention must list at least one regex');
  } else {
    for (const [index, pattern] of raw.mustMention.entries()) {
      try {
        new RegExp(pattern, 'i');
      } catch (error) {
        errors.push(`mustMention[${index}] is not a valid regex: ${error.message}`);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors,
    value: {
      id,
      title: raw.title,
      origin: raw.origin,
      sourcePRs: raw.sourcePRs ?? [],
      fixPRs: raw.fixPRs ?? [],
      base: raw.base,
      seam: raw.seam,
      branches,
      expected: {
        defect: expected.defect.trim(),
        files: expected.files,
        symbols: expected.symbols ?? [],
      },
      mustMention: raw.mustMention,
      mustNotMiss: raw.mustNotMiss,
      notes: typeof raw.notes === 'string' ? raw.notes.trim() : '',
    },
  };
}

/** Load and validate every case (or the named ones). Throws on any invalid case. */
export function loadCases({ casesDir = CASES_DIR, fixturesDir = FIXTURES_DIR, ids = [] } = {}) {
  const files = fs
    .readdirSync(casesDir)
    .filter((name) => name.endsWith('.yaml'))
    .sort();
  const cases = [];
  const problems = [];
  for (const file of files) {
    const raw = loadYaml(fs.readFileSync(path.join(casesDir, file), 'utf8'));
    const result = validateCase(raw, { fileExists: fs.existsSync, fixturesDir });
    if (!result.ok) {
      problems.push(`${file}:\n  - ${result.errors.join('\n  - ')}`);
      continue;
    }
    if (`${result.value.id}.yaml` !== file)
      problems.push(`${file}: id ${result.value.id} must match the file name`);
    else cases.push(result.value);
  }
  if (problems.length > 0) throw new Error(`Invalid eval cases:\n${problems.join('\n')}`);
  if (ids.length === 0) return cases;
  const unknown = ids.filter((id) => !cases.some((c) => c.id === id));
  if (unknown.length > 0) throw new Error(`Unknown case(s): ${unknown.join(', ')}`);
  return cases.filter((c) => ids.includes(c.id));
}

// ---------------------------------------------------------------- prompts

/**
 * The review prompt: the harness's real entry point, plus plumbing that
 * points it at the case base instead of `main`. It must never hint at the
 * expected defect.
 */
export function buildReviewPrompt(evalCase, branchRefs) {
  return [
    `/ship-check ${branchRefs.join(' ')}`,
    '',
    `Eval harness note: these branches were cut from commit ${evalCase.base}. Treat that commit as`,
    '`main`/`origin/main` for every diff and gate (e.g. `git diff <base>...<branch>`, and',
    `\`npm run integration-check -- --base ${evalCase.base} --no-fetch <branches>\`).`,
    'Do not push, open PRs, or run gh mutations. End with your consolidated findings, ranked by',
    'severity, each with file:line.',
  ].join('\n');
}

export function buildJudgePrompt({ rubric, evalCase, reviewText }) {
  return [
    rubric.trim(),
    '',
    '## Case',
    `id: ${evalCase.id}`,
    `seam: ${evalCase.seam}`,
    `branches: ${evalCase.branches.map((b) => b.name).join(', ')}`,
    `severity it must not miss: ${evalCase.mustNotMiss}`,
    '',
    '### Expected defect',
    evalCase.expected.defect,
    '',
    `Files a correct review must cite: ${evalCase.expected.files.join(', ')}`,
    evalCase.expected.symbols.length > 0
      ? `Symbols: ${evalCase.expected.symbols.join(', ')}`
      : 'Symbols: (none required)',
    '',
    '## Review under evaluation (verbatim)',
    '<review>',
    reviewText,
    '</review>',
    '',
    'Reply with ONLY the JSON object described in the rubric.',
  ].join('\n');
}

// ---------------------------------------------------------------- grading

export function parseClaudeJson(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`could not parse claude JSON output: ${String(stdout).slice(0, 200)}`);
  }
  return {
    text: typeof parsed.result === 'string' ? parsed.result : '',
    costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null,
    durationMs: typeof parsed.duration_ms === 'number' ? parsed.duration_ms : null,
    numTurns: typeof parsed.num_turns === 'number' ? parsed.num_turns : null,
    isError: parsed.is_error === true,
    sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : null,
  };
}

export function parseJudgeVerdict(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no judge verdict JSON found');
  let parsed;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch (error) {
    throw new Error(`judge verdict JSON is malformed: ${error.message}`);
  }
  if (typeof parsed.caught !== 'boolean') throw new Error('judge verdict needs boolean caught');
  const score = Math.max(0, Math.min(3, Math.round(Number(parsed.score) || 0)));
  return { caught: parsed.caught, score, reason: String(parsed.reason ?? '') };
}

export function gradeMustMention(text, patterns) {
  const passed = [];
  const missed = [];
  for (const pattern of patterns)
    (new RegExp(pattern, 'i').test(text) ? passed : missed).push(pattern);
  return { passed, missed, allPassed: missed.length === 0 };
}

// ---------------------------------------------------------------- reporting

/** Per-case caught counts across repeated runs; `flipped` = runs disagreed. */
export function summarise(runs) {
  const byCase = {};
  for (const run of runs) {
    const entry = (byCase[run.caseId] ??= { runs: 0, caught: 0, scores: [] });
    entry.runs += 1;
    if (run.caught) entry.caught += 1;
    if (typeof run.judge?.score === 'number') entry.scores.push(run.judge.score);
  }
  const out = {};
  for (const [caseId, entry] of Object.entries(byCase)) {
    out[caseId] = {
      runs: entry.runs,
      caught: entry.caught,
      flipped: entry.caught > 0 && entry.caught < entry.runs,
      meanScore:
        entry.scores.length === 0
          ? null
          : Math.round((entry.scores.reduce((a, b) => a + b, 0) / entry.scores.length) * 100) / 100,
    };
  }
  return out;
}

/** Cases whose caught rate changed between two invocations (same or different config). */
export function diffFlips(previous, current) {
  const before = summarise(previous.runs);
  const after = summarise(current.runs);
  const flips = [];
  for (const caseId of Object.keys(after).sort()) {
    const b = before[caseId];
    const a = after[caseId];
    if (!b) continue;
    const rateBefore = b.caught / b.runs;
    const rateAfter = a.caught / a.runs;
    if (rateBefore === rateAfter) continue;
    flips.push({
      caseId,
      before: `${b.caught}/${b.runs}`,
      after: `${a.caught}/${a.runs}`,
      kind: rateAfter > rateBefore ? 'improved' : 'regressed',
    });
  }
  return flips;
}

const cell = (value) =>
  String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');

export function formatSummaryMarkdown(result, flips, comparedTo) {
  const summary = summarise(result.runs);
  const lines = [
    `# Harness eval: ${result.config}`,
    '',
    `Started ${result.startedAt}${result.dryRun ? ' (dry run: no model calls)' : ''}.`,
    '',
  ];
  if (result.dryRun) {
    lines.push('| case | patches apply | combined merge | error |', '|---|---|---|---|');
    for (const run of result.runs)
      lines.push(
        `| ${run.caseId} | ${run.applied ? 'yes' : 'NO'} | ${run.combinedMerge ?? ''} | ${cell(run.error)} |`
      );
    return `${lines.join('\n')}\n`;
  }
  lines.push(
    '| case | caught | flipped within config | mean judge score | mustMention (all runs) | cost USD | minutes |',
    '|---|---|---|---|---|---|---|'
  );
  for (const [caseId, entry] of Object.entries(summary)) {
    const runs = result.runs.filter((r) => r.caseId === caseId);
    const mentions = runs
      .map((r) =>
        r.deterministic
          ? `${r.deterministic.passed.length}/${r.deterministic.passed.length + r.deterministic.missed.length}`
          : 'n/a'
      )
      .join(', ');
    const cost = runs.reduce((sum, r) => sum + (r.review?.costUsd ?? 0), 0);
    const minutes = runs.reduce((sum, r) => sum + (r.review?.durationMs ?? 0), 0) / 60000;
    lines.push(
      `| ${caseId} | ${entry.caught}/${entry.runs} | ${entry.flipped ? 'YES' : 'no'} | ${entry.meanScore ?? 'n/a'} | ${mentions} | ${cost.toFixed(2)} | ${minutes.toFixed(1)} |`
    );
  }
  const totalCaught = Object.values(summary).reduce((sum, e) => sum + e.caught, 0);
  const totalRuns = Object.values(summary).reduce((sum, e) => sum + e.runs, 0);
  lines.push('', `Aggregate: ${totalCaught}/${totalRuns} runs caught the seam defect.`);
  const errors = result.runs.filter((r) => r.error);
  if (errors.length > 0) {
    lines.push('', '## Errors');
    for (const run of errors) lines.push(`- ${run.caseId} run ${run.run}: ${cell(run.error)}`);
  }
  if (flips) {
    lines.push('', `## Flips${comparedTo ? ` vs ${comparedTo}` : ''}`);
    if (flips.length === 0) lines.push('', 'No case changed its caught rate.');
    else {
      lines.push('', '| case | before | after | kind |', '|---|---|---|---|');
      for (const flip of flips)
        lines.push(`| ${flip.caseId} | ${flip.before} | ${flip.after} | ${flip.kind} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------- execution

/** Default process runner: the injectable seam the unit tests replace. */
export const nodeExec = {
  run(command, args, opts = {}) {
    const result = spawnSync(command, args, {
      cwd: opts.cwd,
      input: opts.input,
      encoding: 'utf8',
      timeout: opts.timeout,
      maxBuffer: 64 * 1024 * 1024,
      env: opts.env ?? process.env,
    });
    return {
      status: result.status ?? (result.error ? 1 : 0),
      stdout: result.stdout ?? '',
      stderr: `${result.stderr ?? ''}${result.error ? String(result.error) : ''}`,
    };
  },
};

const IDENTITY = [
  '-c',
  'user.name=restura-harness-eval',
  '-c',
  'user.email=harness-eval@localhost',
];

function must(exec, args, what) {
  const result = exec.run('git', args);
  if (result.status !== 0)
    throw new Error(`${what} failed: ${(result.stderr || result.stdout || '').trim()}`);
  return result;
}

/**
 * Build the case's branches in a throwaway worktree, optionally review and
 * grade them, then ALWAYS remove the worktree and branches.
 * @param {any} evalCase validated case
 * @param {{ exec: typeof nodeExec; repo: string; tempDir: string; runId: string; dryRun: boolean;
 *   judge?: boolean; rubric?: string; judgeModel?: string; maxBudgetUsd?: number;
 *   setup?: (worktree: string) => void }} ctx
 */
export function runCase(evalCase, ctx) {
  const { exec, repo, tempDir, runId } = ctx;
  const worktree = path.join(tempDir, 'worktree');
  const created = [];
  const refs = evalCase.branches.map((b) => `harness-eval/${runId}/${b.name}`);
  const outcome = { caseId: evalCase.id, branches: refs, applied: false };
  let worktreeAdded = false;
  try {
    must(exec, ['-C', repo, 'rev-parse', '--verify', `${evalCase.base}^{commit}`], 'resolve base');
    must(
      exec,
      ['-C', repo, 'worktree', 'add', '--detach', worktree, evalCase.base],
      'worktree add'
    );
    worktreeAdded = true;
    for (const [index, branch] of evalCase.branches.entries()) {
      must(exec, ['-C', worktree, 'checkout', '-q', '--detach', evalCase.base], 'checkout base');
      must(exec, ['-C', worktree, 'checkout', '-q', '-b', refs[index]], 'create branch');
      created.push(refs[index]);
      for (const [p, patchPath] of branch.patchPaths.entries()) {
        must(
          exec,
          ['-C', worktree, 'apply', '--index', patchPath],
          `apply ${branch.patches[p]} on ${branch.name}`
        );
        must(
          exec,
          [
            '-C',
            worktree,
            ...IDENTITY,
            'commit',
            '-q',
            '--no-verify',
            '-m',
            `${evalCase.id}: ${branch.name} (${branch.patches[p]})`,
          ],
          `commit ${branch.patches[p]}`
        );
      }
    }
    outcome.applied = true;

    // The seam must be semantic: the branches have to merge cleanly.
    must(exec, ['-C', worktree, 'checkout', '-q', '--detach', evalCase.base], 'checkout base');
    outcome.combinedMerge = 'clean';
    for (const ref of refs) {
      const merge = exec.run('git', [
        '-C',
        worktree,
        ...IDENTITY,
        'merge',
        '-q',
        '--no-ff',
        '--no-edit',
        '--no-verify',
        ref,
      ]);
      if (merge.status !== 0) {
        outcome.combinedMerge = 'conflict';
        exec.run('git', ['-C', worktree, 'merge', '--abort']);
        break;
      }
    }
    if (ctx.dryRun) return outcome;

    must(exec, ['-C', worktree, 'checkout', '-q', refs[0]], 'checkout first branch');
    (ctx.setup ?? ((dir) => setupWorktree(dir, () => {})))(worktree);
    const reviewArgs = [
      '-p',
      '--output-format',
      'json',
      '--no-session-persistence',
      '--max-budget-usd',
      String(ctx.maxBudgetUsd ?? 20),
      '--permission-mode',
      'dontAsk',
      '--allowedTools',
      'Bash',
      'Read',
      'Grep',
      'Glob',
      'Task',
      'Skill',
      '--disallowedTools',
      'Bash(git push:*)',
      'Bash(gh:*)',
    ];
    const review = exec.run('claude', reviewArgs, {
      cwd: worktree,
      input: buildReviewPrompt(evalCase, refs),
      timeout: REVIEW_TIMEOUT_MS,
    });
    if (review.status !== 0 && !review.stdout)
      throw new Error(`claude review failed: ${review.stderr.trim().slice(0, 500)}`);
    outcome.review = parseClaudeJson(review.stdout);
    outcome.deterministic = gradeMustMention(outcome.review.text, evalCase.mustMention);
    outcome.judge = null;
    if (ctx.judge !== false) {
      const judgeArgs = [
        '-p',
        '--output-format',
        'json',
        '--no-session-persistence',
        '--tools',
        '',
      ];
      if (ctx.judgeModel) judgeArgs.push('--model', ctx.judgeModel);
      const judged = exec.run('claude', judgeArgs, {
        cwd: tempDir,
        input: buildJudgePrompt({
          rubric: ctx.rubric ?? '',
          evalCase,
          reviewText: outcome.review.text,
        }),
        timeout: JUDGE_TIMEOUT_MS,
      });
      try {
        const judgeOut = parseClaudeJson(judged.stdout);
        outcome.judgeCostUsd = judgeOut.costUsd;
        outcome.judge = parseJudgeVerdict(judgeOut.text);
      } catch (error) {
        outcome.judgeError = error.message;
      }
    }
    outcome.caught = outcome.judge ? outcome.judge.caught : outcome.deterministic.allPassed;
    outcome.caughtSource = outcome.judge ? 'judge' : 'mustMention';
    return outcome;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
    outcome.caught = false;
    return outcome;
  } finally {
    if (worktreeAdded) exec.run('git', ['-C', repo, 'worktree', 'remove', '--force', worktree]);
    for (const ref of created) exec.run('git', ['-C', repo, 'branch', '-D', ref]);
    exec.run('git', ['-C', repo, 'worktree', 'prune']);
  }
}

/** Most recent result file for `config` in `outDir`, excluding `exclude`. */
export function latestResult(outDir, config, exclude) {
  if (!fs.existsSync(outDir)) return undefined;
  const files = fs
    .readdirSync(outDir)
    .filter((name) => name.endsWith(`--${config}.json`))
    .map((name) => path.join(outDir, name))
    .filter((file) => file !== exclude)
    .sort();
  return files.at(-1);
}

export function runEval(options, { exec = nodeExec, log = console.log } = {}) {
  const repo = exec.run('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT }).stdout.trim();
  const cases = loadCases({ ids: options.caseIds });
  const rubric = options.dryRun ? '' : fs.readFileSync(RUBRIC_PATH, 'utf8');
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, '-');
  const runs = options.dryRun ? 1 : options.runs;
  const result = {
    config: options.config,
    startedAt,
    dryRun: options.dryRun,
    harnessSha: exec.run('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).stdout.trim(),
    runsPerCase: runs,
    runs: [],
  };
  if (!options.dryRun)
    log(`Running ${cases.length} case(s) x ${runs} run(s) with config "${options.config}".`);
  for (const evalCase of cases) {
    for (let run = 1; run <= runs; run += 1) {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), `restura-harness-eval-${evalCase.id}-`)
      );
      const runId = `${stamp}-${run}`.toLowerCase();
      log(`${evalCase.id} run ${run}/${runs}…`);
      const outcome = runCase(evalCase, {
        exec,
        repo,
        tempDir,
        runId,
        dryRun: options.dryRun,
        judge: options.judge,
        rubric,
        judgeModel: options.judgeModel,
        maxBudgetUsd: options.maxBudgetUsd,
      });
      fs.rmSync(tempDir, { recursive: true, force: true });
      result.runs.push({ run, origin: evalCase.origin, ...outcome });
      log(
        options.dryRun
          ? `  patches ${outcome.applied ? 'apply' : 'FAIL'}; combined merge ${outcome.combinedMerge ?? 'n/a'}${outcome.error ? `; ${outcome.error}` : ''}`
          : `  caught=${outcome.caught} (${outcome.caughtSource ?? 'error'})${outcome.error ? `; ${outcome.error}` : ''}`
      );
    }
  }

  const outDir = path.resolve(ROOT, options.out);
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, `${stamp}${options.dryRun ? '--dry-run' : ''}--${options.config}`);
  let flips;
  let comparedTo;
  if (!options.dryRun) {
    const previousFile = options.compare ?? latestResult(outDir, options.config, `${base}.json`);
    if (previousFile && fs.existsSync(previousFile)) {
      flips = diffFlips(JSON.parse(fs.readFileSync(previousFile, 'utf8')), result);
      comparedTo = path.basename(previousFile);
    }
  }
  fs.writeFileSync(`${base}.json`, `${JSON.stringify(result, null, 2)}\n`);
  const markdown = formatSummaryMarkdown(result, flips, comparedTo);
  fs.writeFileSync(`${base}.md`, markdown);
  log(`\n${markdown}`);
  log(`Wrote ${base}.json and ${base}.md`);
  const failed = options.dryRun
    ? result.runs.some((r) => !r.applied || r.combinedMerge !== 'clean')
    : result.runs.some((r) => r.error);
  return { result, failed };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const { failed } = runEval(parseEvalArgs(process.argv.slice(2)));
    process.exitCode = failed ? 1 : 0;
  } catch (error) {
    console.error(`harness-eval: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
