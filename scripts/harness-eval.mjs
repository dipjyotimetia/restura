#!/usr/bin/env node
// Harness eval: does the review pipeline catch SEAM bugs without crying wolf?
//
// Each defect case under evals/harness/cases/ is a real (or labelled
// synthetic) incident where PRs were green alone but broken together, or
// where one harness (web Worker / Electron / CLI) was left unwired. Control
// cases (`expectClean: true`) are real merged PRs that were genuinely fine.
// A run rebuilds the branch(es) from patch fixtures in a throwaway worktree,
// asks the review entry point (`/ship-check --quick <branches>`) to review
// them via `claude -p`, and grades the final answer with an LLM rubric judge
// (evals/harness/rubric.md) plus, for defect cases, `mustMention` regexes. A
// defect counts as caught only when the judge says so AND a file-or-symbol
// pattern matches. Harness failures (permission denials, budget, crashes) are
// recorded as errors and excluded from recall/precision. Results land in
// --out as one JSON per invocation plus a markdown summary, with a flip report
// against the previous invocation of the same --config.
//
// Usage:
//   npm run eval:harness -- [--case <id>]... [--runs N] [--config <label>]
//     [--dry-run] [--out <dir>] [--no-judge] [--max-budget-usd <n>]
//     [--judge-model <model>] [--compare <result.json>]
//   npm run eval:harness -- --cleanup   # remove leftovers of crashed runs
//
// --dry-run validates every case and applies its patches (plus the combined
// merge) in throwaway worktrees without calling any model.

import { spawn, spawnSync } from 'node:child_process';
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

/** Branch namespace every run creates; `--cleanup` touches nothing else. */
export const BRANCH_PREFIX = 'harness-eval/';
const TEMP_PREFIX = 'restura-harness-eval-';
const TEMP_WORKTREE_RE = /(?:^|\/)restura-harness-eval-[^/]+\/worktree$/;

const ORIGINS = ['real', 'synthetic'];
const SEAMS = ['cross-branch', 'cross-harness', 'cross-consumer'];
const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const CONFIG_RE = /^[A-Za-z0-9._-]+$/;
const REVIEW_TIMEOUT_MS = 90 * 60 * 1000;
const JUDGE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Generic review prose. An anchor pattern that matches this would credit a
 * review that never named the defective file or symbol, so it is rejected.
 */
const GENERIC_PROBE =
  'The web and desktop and CLI request path sends a GET with auth headers, a body, presets, ' +
  'variables, tokens and a timeout; check parity between the Worker, Electron and the runner.';

// ---------------------------------------------------------------- arguments

export function parseEvalArgs(argv) {
  const options = {
    caseIds: [],
    runs: 2,
    config: 'current',
    dryRun: false,
    cleanup: false,
    out: '.claude/metrics/evals',
    judge: true,
    judgeModel: undefined,
    maxBudgetUsd: 20,
    compare: undefined,
  };
  const valued = [
    '--case',
    '--runs',
    '--config',
    '--out',
    '--judge-model',
    '--max-budget-usd',
    '--compare',
  ];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const name = arg.split('=')[0];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--cleanup') options.cleanup = true;
    else if (arg === '--no-judge') options.judge = false;
    else if (valued.includes(name)) {
      let value;
      if (arg.startsWith(`${name}=`)) value = arg.slice(name.length + 1);
      else {
        value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
        index += 1;
      }
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

/** Strings an anchor pattern may match: expected file paths, basenames, symbols. */
function anchorTargets(files, symbols) {
  const out = [];
  for (const file of files) {
    const base = path.posix.basename(file);
    out.push(file, base, base.replace(/\.[^.]+$/, ''));
  }
  return [...out, ...symbols];
}

function validateBranches(raw, caseDir, fileExists, errors) {
  const branches = [];
  if (!Array.isArray(raw.branches) || raw.branches.length === 0 || raw.branches.length > 3) {
    errors.push('branches must list 1-3 branches');
    return branches;
  }
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
  return branches;
}

/**
 * Validate one parsed case file. Reports every problem, not just the first.
 * @param {any} raw
 * @param {{ fileExists: (p: string) => boolean; fixturesDir?: string }} options
 */
export function validateCase(raw, { fileExists, fixturesDir = FIXTURES_DIR }) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['case is not a mapping'] };
  const id = raw.id;
  const expectClean = raw.expectClean === true;
  if (raw.expectClean !== undefined && typeof raw.expectClean !== 'boolean')
    errors.push('expectClean must be a boolean');
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

  const caseDir = path.join(fixturesDir, typeof id === 'string' ? id : '_');
  const branches = validateBranches(raw, caseDir, fileExists, errors);
  const expected = raw.expected ?? {};
  if (!(isStringArray(expected.files) && expected.files.length > 0))
    errors.push('expected.files must name at least one file');
  if (expected.symbols !== undefined && !isStringArray(expected.symbols))
    errors.push('expected.symbols must be a list of strings');
  const files = isStringArray(expected.files) ? expected.files : [];
  const symbols = isStringArray(expected.symbols) ? expected.symbols : [];

  let anchors = [];
  if (expectClean) {
    if (raw.seam !== 'none') errors.push('seam must be none for a clean control');
    if (
      raw.mustMention !== undefined &&
      !(Array.isArray(raw.mustMention) && raw.mustMention.length === 0)
    )
      errors.push('mustMention must be empty for a clean control (the judge grades it)');
    if (typeof expected.summary !== 'string' || expected.summary.trim() === '')
      errors.push('expected.summary is required for a clean control');
    if (expected.defect !== undefined) errors.push('a clean control has no expected.defect');
  } else {
    if (!SEAMS.includes(raw.seam)) errors.push(`seam must be one of ${SEAMS.join('|')}`);
    if (!SEVERITIES.includes(raw.mustNotMiss))
      errors.push(`mustNotMiss must be one of ${SEVERITIES.join('|')}`);
    if (typeof expected.defect !== 'string' || expected.defect.trim() === '')
      errors.push('expected.defect is required');
    if (!(isStringArray(raw.mustMention) && raw.mustMention.length > 0)) {
      errors.push('mustMention must list at least one regex');
    } else {
      const targets = anchorTargets(files, symbols);
      const valid = [];
      for (const [index, pattern] of raw.mustMention.entries()) {
        try {
          valid.push([pattern, new RegExp(pattern, 'i')]);
        } catch (error) {
          errors.push(`mustMention[${index}] is not a valid regex: ${error.message}`);
        }
      }
      const named = valid.filter(([, re]) => targets.some((t) => re.test(t)));
      anchors = named.filter(([, re]) => !re.test(GENERIC_PROBE)).map(([p]) => p);
      if (valid.length === raw.mustMention.length && named.length === 0)
        errors.push(
          'mustMention needs a pattern that names a file or symbol from expected.files/expected.symbols'
        );
      else if (named.length > 0 && anchors.length === 0)
        errors.push(
          `every file or symbol mustMention pattern is too loose (it matches generic review prose): ${named.map(([p]) => p).join(', ')}`
        );
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
      expectClean,
      sourcePRs: raw.sourcePRs ?? [],
      fixPRs: raw.fixPRs ?? [],
      base: raw.base,
      seam: raw.seam,
      branches,
      expected: {
        defect: expectClean ? '' : expected.defect.trim(),
        summary: expectClean ? expected.summary.trim() : '',
        files,
        symbols,
      },
      mustMention: expectClean ? [] : raw.mustMention,
      anchors,
      mustNotMiss: expectClean ? null : raw.mustNotMiss,
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
 * points it at the case base instead of `main`. It is identical for defect
 * and control cases and never hints at the expected outcome.
 */
export function buildReviewPrompt(evalCase, branchRefs) {
  return [
    `/ship-check --quick ${branchRefs.join(' ')}`,
    '',
    `Eval harness note: these branches were cut from commit ${evalCase.base}. Treat that commit as`,
    '`main`/`origin/main` for every diff and gate (e.g. `git diff <base>...<branch>`, and',
    `\`npm run integration-check -- --base ${evalCase.base} --no-fetch <branches>\`).`,
    'Do not push, open PRs, or run gh mutations. End with your consolidated findings, ranked by',
    'severity, each with file:line.',
  ].join('\n');
}

export function buildJudgePrompt({ rubric, evalCase, reviewText }) {
  const head = [
    rubric.trim(),
    '',
    '## Case',
    `id: ${evalCase.id}`,
    `branches: ${evalCase.branches.map((b) => b.name).join(', ')}`,
  ];
  const body = evalCase.expectClean
    ? [
        'type: CONTROL (expectClean). Grade with the "Control cases" section of the rubric.',
        '',
        '### What the change does (it was merged and needed no follow-up fix)',
        evalCase.expected.summary,
        '',
        `Fixture files: ${evalCase.expected.files.join(', ')}`,
      ]
    : [
        'type: DEFECT',
        `seam: ${evalCase.seam}`,
        `severity it must not miss: ${evalCase.mustNotMiss}`,
        '',
        '### Expected defect',
        evalCase.expected.defect,
        '',
        `Files a correct review must cite: ${evalCase.expected.files.join(', ')}`,
        evalCase.expected.symbols.length > 0
          ? `Symbols: ${evalCase.expected.symbols.join(', ')}`
          : 'Symbols: (none required)',
      ];
  return [
    ...head,
    ...body,
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
  if (!parsed || typeof parsed !== 'object')
    throw new Error('could not parse claude JSON output: not an object');
  return {
    text: typeof parsed.result === 'string' ? parsed.result : '',
    subtype: typeof parsed.subtype === 'string' ? parsed.subtype : null,
    costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null,
    durationMs: typeof parsed.duration_ms === 'number' ? parsed.duration_ms : null,
    numTurns: typeof parsed.num_turns === 'number' ? parsed.num_turns : null,
    isError: parsed.is_error === true,
    sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : null,
    permissionDenials: Array.isArray(parsed.permission_denials) ? parsed.permission_denials : [],
  };
}

/** @type {Array<[RegExp, string]>} */
const STDERR_ERRORS = [
  [/not allowed|tool.{0,40}(disallowed|unavailable)/i, 'tool not allowed'],
  [/permission (was )?denied|requires? (approval|permission)/i, 'permission denied'],
  [/budget/i, 'budget exhausted'],
];

/**
 * Was this `claude -p` invocation a real answer, or a harness failure that
 * must not count as a miss? Only stderr and the JSON envelope are inspected,
 * never the answer text (a review may legitimately discuss permissions).
 * @param {{ status: number | null; signal?: string | null; stdout: string; stderr?: string }} run
 */
export function classifyClaudeRun(run) {
  const stderr = (run.stderr ?? '').trim();
  const firstLine = (text) => text.split('\n').find(Boolean)?.slice(0, 200) ?? '';
  if (run.signal) return { status: 'error', reason: `claude killed by signal ${run.signal}` };
  if (run.status !== 0)
    return { status: 'error', reason: `claude exited ${run.status}: ${firstLine(stderr)}` };
  for (const [re, label] of STDERR_ERRORS)
    if (re.test(stderr)) return { status: 'error', reason: `${label}: ${firstLine(stderr)}` };
  let parsed;
  try {
    parsed = parseClaudeJson(run.stdout);
  } catch (error) {
    return { status: 'error', reason: `unparseable claude JSON (${error.message.slice(0, 120)})` };
  }
  if (parsed.permissionDenials.length > 0) {
    const tools = [...new Set(parsed.permissionDenials.map((d) => d?.tool_name ?? '?'))];
    return { status: 'error', reason: `permission denied: ${tools.join(', ')}`, parsed };
  }
  if (parsed.subtype && /budget/i.test(parsed.subtype))
    return { status: 'error', reason: `budget exhausted (${parsed.subtype})`, parsed };
  if (parsed.subtype?.startsWith('error'))
    return { status: 'error', reason: `claude ended with ${parsed.subtype}`, parsed };
  if (parsed.isError) return { status: 'error', reason: 'claude reported is_error', parsed };
  return { status: 'ok', parsed };
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

export function gradeMustMention(text, patterns, anchors = []) {
  const passed = [];
  const missed = [];
  for (const pattern of patterns)
    (new RegExp(pattern, 'i').test(text) ? passed : missed).push(pattern);
  return {
    passed,
    missed,
    allPassed: missed.length === 0,
    anchorMatched: anchors.some((anchor) => passed.includes(anchor)),
  };
}

/**
 * Defect cases: the judge must say caught AND a file-or-symbol pattern must
 * match (patterns alone when the judge is disabled). Controls: the judge's
 * "no high/medium defect in the fixture files" verdict.
 */
export function decideCaught(evalCase, judge, deterministic) {
  if (evalCase.expectClean) return judge ? judge.caught : null;
  if (!judge) return Boolean(deterministic?.anchorMatched && deterministic?.allPassed);
  return judge.caught && Boolean(deterministic?.anchorMatched);
}

// ---------------------------------------------------------------- reporting

const scored = (run) => run.status !== 'error';

/** Per-case results across repeated runs, with defect recall and control precision. */
export function summarise(runs) {
  const byCase = {};
  for (const run of runs) {
    const entry = (byCase[run.caseId] ??= {
      expectClean: run.expectClean === true,
      runs: 0,
      caught: 0,
      errors: 0,
      scores: [],
    });
    if (!scored(run)) {
      entry.errors += 1;
      continue;
    }
    entry.runs += 1;
    if (run.caught) entry.caught += 1;
    if (typeof run.judge?.score === 'number') entry.scores.push(run.judge.score);
  }
  const cases = {};
  const recall = { caught: 0, runs: 0 };
  const controls = { clean: 0, falsePositives: 0, runs: 0 };
  let errors = 0;
  for (const [caseId, entry] of Object.entries(byCase)) {
    errors += entry.errors;
    cases[caseId] = {
      expectClean: entry.expectClean,
      runs: entry.runs,
      caught: entry.caught,
      errors: entry.errors,
      flipped: entry.caught > 0 && entry.caught < entry.runs,
      meanScore:
        entry.scores.length === 0
          ? null
          : Math.round((entry.scores.reduce((a, b) => a + b, 0) / entry.scores.length) * 100) / 100,
    };
    if (entry.expectClean) {
      controls.runs += entry.runs;
      controls.clean += entry.caught;
      controls.falsePositives += entry.runs - entry.caught;
    } else {
      recall.runs += entry.runs;
      recall.caught += entry.caught;
    }
  }
  return { cases, recall, controls, errors };
}

/** Cases whose caught rate (over scored runs) changed between two invocations. */
export function diffFlips(previous, current) {
  const before = summarise(previous.runs).cases;
  const after = summarise(current.runs).cases;
  const flips = [];
  for (const caseId of Object.keys(after).sort()) {
    const b = before[caseId];
    const a = after[caseId];
    if (!b || b.runs === 0 || a.runs === 0) continue;
    const rateBefore = b.caught / b.runs;
    const rateAfter = a.caught / a.runs;
    if (rateBefore === rateAfter) continue;
    flips.push({
      caseId,
      type: a.expectClean ? 'control' : 'defect',
      before: `${b.caught}/${b.runs}`,
      after: `${a.caught}/${a.runs}`,
      kind: rateAfter > rateBefore ? 'improved' : 'regressed',
    });
  }
  return flips;
}

const cell = (value) =>
  String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

export function formatSummaryMarkdown(result, flips, comparedTo) {
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
        `| ${run.caseId} | ${run.applied ? 'yes' : 'NO'} | ${run.combinedMerge ?? ''} | ${cell(run.reason)} |`
      );
    return `${lines.join('\n')}\n`;
  }
  const summary = summarise(result.runs);
  lines.push(
    `Recall on defect cases: ${summary.recall.caught}/${summary.recall.runs} scored runs caught the seam defect.`,
    `Controls: ${summary.controls.clean}/${summary.controls.runs} clean, ${plural(summary.controls.falsePositives, 'false positive')}.`,
    `Harness errors (excluded from both): ${summary.errors}.`,
    '',
    '"caught" for a control means the review reported no high/medium defect in its files. ' +
      'judge-only / pattern-only count scored runs where just one grader said caught.',
    '',
    '| case | type | caught | errors | flipped | mean judge score | judge-only | pattern-only | cost USD | minutes |',
    '|---|---|---|---|---|---|---|---|---|---|'
  );
  for (const [caseId, entry] of Object.entries(summary.cases)) {
    const runs = result.runs.filter((r) => r.caseId === caseId);
    const ok = runs.filter(scored);
    const judgeOnly = entry.expectClean
      ? 'n/a'
      : ok.filter((r) => r.judgeCaught && !r.patternCaught).length;
    const patternOnly = entry.expectClean
      ? 'n/a'
      : ok.filter((r) => !r.judgeCaught && r.patternCaught).length;
    const cost = runs.reduce((sum, r) => sum + (r.review?.costUsd ?? 0), 0);
    const minutes = runs.reduce((sum, r) => sum + (r.review?.durationMs ?? 0), 0) / 60000;
    lines.push(
      `| ${caseId} | ${entry.expectClean ? 'control' : 'defect'} | ${entry.caught}/${entry.runs} | ${entry.errors} | ${entry.flipped ? 'YES' : 'no'} | ${entry.meanScore ?? 'n/a'} | ${judgeOnly} | ${patternOnly} | ${cost.toFixed(2)} | ${minutes.toFixed(1)} |`
    );
  }
  const errored = result.runs.filter((r) => !scored(r));
  if (errored.length > 0) {
    lines.push('', '## Harness errors (not counted as misses)', '');
    for (const run of errored) lines.push(`- ${run.caseId} run ${run.run}: ${cell(run.reason)}`);
  }
  if (flips) {
    lines.push('', `## Flips${comparedTo ? ` vs ${comparedTo}` : ''}`);
    if (flips.length === 0) lines.push('', 'No case changed its caught rate.');
    else {
      lines.push('', '| case | type | before | after | kind |', '|---|---|---|---|---|');
      for (const flip of flips)
        lines.push(
          `| ${flip.caseId} | ${flip.type} | ${flip.before} | ${flip.after} | ${flip.kind} |`
        );
    }
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------- leftovers

/** Parse `git worktree list --porcelain`. */
export function parseWorktreePorcelain(text) {
  const entries = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split('\n').filter(Boolean);
    const head = lines.find((l) => l.startsWith('worktree '));
    if (!head) continue;
    const branchLine = lines.find((l) => l.startsWith('branch '));
    entries.push({
      path: head.slice('worktree '.length),
      branch: branchLine ? branchLine.slice('branch '.length).replace(/^refs\/heads\//, '') : null,
    });
  }
  return entries;
}

/** Leftovers of crashed runs: `harness-eval/` branches and this tool's temp worktrees only. */
export function selectLeftovers({ branches, worktrees }) {
  return {
    branches: branches.filter((b) => b.startsWith(BRANCH_PREFIX)),
    worktrees: worktrees
      .filter((w) => TEMP_WORKTREE_RE.test(w.path) || w.branch?.startsWith(BRANCH_PREFIX))
      .map((w) => w.path),
  };
}

// ---------------------------------------------------------------- execution

let activeChild = null;

/** Default process runner (async so signal handlers can fire mid-run). */
export const nodeExec = {
  run(command, args, opts = {}) {
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      activeChild = child;
      let stdout = '';
      let stderr = '';
      let timer;
      if (opts.timeout)
        timer = setTimeout(() => {
          stderr += `\ntimed out after ${opts.timeout} ms`;
          child.kill('SIGTERM');
        }, opts.timeout);
      child.stdout.setEncoding('utf8').on('data', (d) => {
        stdout += d;
      });
      child.stderr.setEncoding('utf8').on('data', (d) => {
        stderr += d;
      });
      child.on('error', (error) => {
        stderr += String(error);
      });
      child.on('close', (status, signal) => {
        clearTimeout(timer);
        if (activeChild === child) activeChild = null;
        resolve({ status: status ?? (signal ? null : 1), signal, stdout, stderr });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(opts.input ?? '');
    });
  },
};

/** Synchronous runner for cleanup paths (signal handlers, --cleanup). */
export const syncExec = {
  run(command, args, opts = {}) {
    const result = spawnSync(command, args, { cwd: opts.cwd, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  },
};

const IDENTITY = [
  '-c',
  'user.name=restura-harness-eval',
  '-c',
  'user.email=harness-eval@localhost',
];

async function must(exec, args, what) {
  const result = await exec.run('git', args);
  if (result.status !== 0)
    throw new Error(`${what} failed: ${(result.stderr || result.stdout || '').trim()}`);
  return result;
}

/** Remove a run's worktree and branches. Works with a sync or async exec. */
export function cleanupTracked(exec, repo, tracker) {
  const calls = [];
  if (tracker.worktree)
    calls.push(exec.run('git', ['-C', repo, 'worktree', 'remove', '--force', tracker.worktree]));
  for (const ref of tracker.branches)
    calls.push(exec.run('git', ['-C', repo, 'branch', '-D', ref]));
  calls.push(exec.run('git', ['-C', repo, 'worktree', 'prune']));
  return calls;
}

/**
 * Build the case's branches in a throwaway worktree, optionally review and
 * grade them, then ALWAYS remove the worktree and branches. `ctx.tracker`
 * mirrors what exists so a signal handler can clean up mid-run.
 * @param {any} evalCase validated case
 * @param {{ exec: { run: Function }; repo: string; tempDir: string; runId: string; dryRun: boolean;
 *   judge?: boolean; rubric?: string; judgeModel?: string; maxBudgetUsd?: number;
 *   setup?: (worktree: string) => void; tracker?: { worktree: string | null; branches: string[] } }} ctx
 */
export async function runCase(evalCase, ctx) {
  const { exec, repo, tempDir, runId } = ctx;
  const tracker = ctx.tracker ?? { worktree: null, branches: [] };
  const worktree = path.join(tempDir, 'worktree');
  const refs = evalCase.branches.map((b) => `${BRANCH_PREFIX}${runId}/${b.name}`);
  const outcome = {
    caseId: evalCase.id,
    expectClean: evalCase.expectClean,
    branches: refs,
    applied: false,
    status: 'ok',
  };
  try {
    await must(
      exec,
      ['-C', repo, 'rev-parse', '--verify', `${evalCase.base}^{commit}`],
      'resolve base'
    );
    await must(
      exec,
      ['-C', repo, 'worktree', 'add', '--detach', worktree, evalCase.base],
      'worktree add'
    );
    tracker.worktree = worktree;
    for (const [index, branch] of evalCase.branches.entries()) {
      await must(
        exec,
        ['-C', worktree, 'checkout', '-q', '--detach', evalCase.base],
        'checkout base'
      );
      await must(exec, ['-C', worktree, 'checkout', '-q', '-b', refs[index]], 'create branch');
      tracker.branches.push(refs[index]);
      for (const [p, patchPath] of branch.patchPaths.entries()) {
        await must(
          exec,
          ['-C', worktree, 'apply', '--index', patchPath],
          `apply ${branch.patches[p]} on ${branch.name}`
        );
        await must(
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
    await must(
      exec,
      ['-C', worktree, 'checkout', '-q', '--detach', evalCase.base],
      'checkout base'
    );
    outcome.combinedMerge = 'clean';
    for (const ref of refs) {
      const merge = await exec.run('git', [
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
        await exec.run('git', ['-C', worktree, 'merge', '--abort']);
        break;
      }
    }
    if (ctx.dryRun) {
      if (outcome.combinedMerge !== 'clean') {
        outcome.status = 'error';
        outcome.reason = 'branches conflict when merged together';
      }
      return outcome;
    }
    if (evalCase.expectClean && ctx.judge === false)
      throw new Error('control cases need the rubric judge (drop --no-judge)');

    await must(exec, ['-C', worktree, 'checkout', '-q', refs[0]], 'checkout first branch');
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
    const reviewRun = classifyClaudeRun(
      await exec.run('claude', reviewArgs, {
        cwd: worktree,
        input: buildReviewPrompt(evalCase, refs),
        timeout: REVIEW_TIMEOUT_MS,
      })
    );
    if (reviewRun.parsed) outcome.review = reviewRun.parsed;
    if (reviewRun.status === 'error') throw new Error(`review: ${reviewRun.reason}`);
    const reviewText = reviewRun.parsed.text;
    outcome.deterministic = evalCase.expectClean
      ? null
      : gradeMustMention(reviewText, evalCase.mustMention, evalCase.anchors);
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
      const judgeRun = classifyClaudeRun(
        await exec.run('claude', judgeArgs, {
          cwd: tempDir,
          input: buildJudgePrompt({ rubric: ctx.rubric ?? '', evalCase, reviewText }),
          timeout: JUDGE_TIMEOUT_MS,
        })
      );
      if (judgeRun.status === 'error') throw new Error(`judge: ${judgeRun.reason}`);
      outcome.judgeCostUsd = judgeRun.parsed.costUsd;
      try {
        outcome.judge = parseJudgeVerdict(judgeRun.parsed.text);
      } catch (error) {
        throw new Error(`judge: ${error.message}`);
      }
    }
    outcome.judgeCaught = outcome.judge ? outcome.judge.caught : null;
    outcome.patternCaught = outcome.deterministic ? outcome.deterministic.anchorMatched : null;
    outcome.caught = decideCaught(evalCase, outcome.judge, outcome.deterministic);
    return outcome;
  } catch (error) {
    outcome.status = 'error';
    outcome.reason = error instanceof Error ? error.message : String(error);
    outcome.caught = null;
    return outcome;
  } finally {
    await Promise.all(cleanupTracked(exec, repo, tracker));
    tracker.worktree = null;
    tracker.branches.length = 0;
  }
}

/** Most recent result file for `config` in `outDir`, excluding `exclude`. */
export function latestResult(outDir, config, exclude) {
  if (!fs.existsSync(outDir)) return undefined;
  const files = fs
    .readdirSync(outDir)
    .filter((name) => name.endsWith(`--${config}.json`) && !name.includes('--dry-run--'))
    .map((name) => path.join(outDir, name))
    .filter((file) => file !== exclude)
    .sort();
  return files.at(-1);
}

/** `--cleanup`: remove leftover harness-eval worktrees and branches, nothing else. */
export function cleanupLeftovers({ exec = syncExec, log = console.log } = {}) {
  const repo = exec.run('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT }).stdout.trim();
  const branches = exec
    .run('git', ['-C', repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/'])
    .stdout.split('\n')
    .filter(Boolean);
  const worktrees = parseWorktreePorcelain(
    exec.run('git', ['-C', repo, 'worktree', 'list', '--porcelain']).stdout
  );
  const leftovers = selectLeftovers({ branches, worktrees });
  for (const worktree of leftovers.worktrees) {
    log(`removing worktree ${worktree}`);
    exec.run('git', ['-C', repo, 'worktree', 'remove', '--force', worktree]);
    const parent = path.dirname(worktree);
    if (path.basename(parent).startsWith(TEMP_PREFIX))
      fs.rmSync(parent, { recursive: true, force: true });
  }
  for (const branch of leftovers.branches) {
    log(`deleting branch ${branch}`);
    exec.run('git', ['-C', repo, 'branch', '-D', branch]);
  }
  exec.run('git', ['-C', repo, 'worktree', 'prune']);
  log(
    `Removed ${plural(leftovers.worktrees.length, 'worktree')} and ${plural(leftovers.branches.length, 'branch', 'branches')}.`
  );
  return leftovers;
}

export async function runEval(options, { exec = nodeExec, log = console.log } = {}) {
  const repo = (
    await exec.run('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT })
  ).stdout.trim();
  const cases = loadCases({ ids: options.caseIds });
  const rubric = options.dryRun ? '' : fs.readFileSync(RUBRIC_PATH, 'utf8');
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, '-');
  const runs = options.dryRun ? 1 : options.runs;
  const result = {
    config: options.config,
    startedAt,
    dryRun: options.dryRun,
    harnessSha: (await exec.run('git', ['rev-parse', 'HEAD'], { cwd: ROOT })).stdout.trim(),
    runsPerCase: runs,
    runs: [],
  };

  // Ctrl-C / kill mid-run: stop the child, remove this run's worktree and
  // branches (the same cleanup `finally` does), exit non-zero.
  const tracker = { worktree: null, branches: [] };
  let tempDir = null;
  const onSignal = (signal) => {
    activeChild?.kill('SIGTERM');
    cleanupTracked(syncExec, repo, tracker);
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    console.error(`\nharness-eval: ${signal}; cleaned up this run's worktree and branches.`);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    if (!options.dryRun)
      log(`Running ${cases.length} case(s) x ${runs} run(s) with config "${options.config}".`);
    for (const evalCase of cases) {
      for (let run = 1; run <= runs; run += 1) {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${TEMP_PREFIX}${evalCase.id}-`));
        log(`${evalCase.id} run ${run}/${runs}…`);
        const outcome = await runCase(evalCase, {
          exec,
          repo,
          tempDir,
          runId: `${stamp}-${run}`.toLowerCase(),
          dryRun: options.dryRun,
          judge: options.judge,
          rubric,
          judgeModel: options.judgeModel,
          maxBudgetUsd: options.maxBudgetUsd,
          tracker,
        });
        fs.rmSync(tempDir, { recursive: true, force: true });
        tempDir = null;
        result.runs.push({ run, origin: evalCase.origin, ...outcome });
        log(
          options.dryRun
            ? `  patches ${outcome.applied ? 'apply' : 'FAIL'}; combined merge ${outcome.combinedMerge ?? 'n/a'}${outcome.reason ? `; ${outcome.reason}` : ''}`
            : outcome.status === 'error'
              ? `  harness error: ${outcome.reason}`
              : `  caught=${outcome.caught} (judge=${outcome.judgeCaught}, pattern=${outcome.patternCaught})`
        );
      }
    }
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
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
    : result.runs.some((r) => r.status === 'error');
  return { result, failed };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const options = parseEvalArgs(process.argv.slice(2));
    if (options.cleanup) cleanupLeftovers();
    else {
      const { failed } = await runEval(options);
      process.exitCode = failed ? 1 : 0;
    }
  } catch (error) {
    console.error(`harness-eval: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
