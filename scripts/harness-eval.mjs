#!/usr/bin/env node
// Harness eval: does the review pipeline catch SEAM bugs without crying wolf?
//
// Each defect case under evals/harness/cases/ is a real (or labelled
// synthetic) incident where PRs were green alone but broken together, or
// where one harness (web Worker / Electron / CLI) was left unwired. Control
// cases (`expectClean: true`) are real merged PRs that were genuinely fine.
// A run rebuilds the branch(es) from patch fixtures in a history-free repo
// (git init + git archive of the base: later fix commits are unreachable)
// whose harness (.claude/skills, agents, hooks, CLAUDE.md, review scripts) is
// first replaced by the one at --harness-ref (the "overlay" commit), so the
// review exercises the harness under test rather than the case base's. It
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
//   npm run eval:harness -- [--case <id>]... [--split train|test|all] [--runs N]
//     [--config <label>] [--harness-ref <ref>] [--model <model>]
//     [--judge-model <model>] [--judge-repeat N] [--dry-run] [--out <dir>]
//     [--no-judge] [--max-budget-usd <n>] [--compare <result-or-baseline.json>]
//     [--save-baseline]
//   npm run eval:harness -- --cleanup   # remove leftovers of crashed runs
//
// --dry-run validates every case, applies the harness overlay and its patches
// (plus the combined merge) in throwaway isolated repos without calling any model.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { linkAction, planLinks } from './worktree-setup.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CASES_DIR = path.join(ROOT, 'evals/harness/cases');
export const FIXTURES_DIR = path.join(ROOT, 'evals/harness/fixtures');
export const RUBRIC_PATH = path.join(ROOT, 'evals/harness/rubric.md');
export const BASELINES_DIR = path.join(ROOT, 'evals/harness/baselines');

/** Base-commit harness paths removed before the overlay (whatever exists). */
export const HARNESS_REMOVE_PATHS = [
  '.claude/skills',
  '.claude/agents',
  '.claude/commands',
  '.claude/hooks',
  '.claude/settings.json',
  '.agents/skills',
];
/**
 * Paths checked out from the harness commit, each only if it exists there.
 * Never `.claude/worktrees`, `.claude/metrics` or `settings.local.json`.
 */
export const HARNESS_OVERLAY_PATHS = [
  '.claude/skills',
  '.claude/agents',
  '.claude/hooks',
  '.claude/settings.json',
  '.agents',
  'CLAUDE.md',
  'AGENTS.md',
  'docs/agents',
  'skills-lock.json',
  'scripts/integration-check.mjs',
  'scripts/verify-agent-report.mjs',
  'scripts/worktree-setup.mjs',
  'scripts/worktree-prune.mjs',
];
/** The only package.json scripts the overlay merges into the base's package.json. */
export const HARNESS_SCRIPT_KEYS = [
  'integration-check',
  'verify:agent-report',
  'worktree:setup',
  'worktree:prune',
];
export const DEFAULT_JUDGE_MODEL = 'sonnet';

/** Branch namespace every run creates; `--cleanup` touches nothing else. */
export const BRANCH_PREFIX = 'harness-eval/';
const TEMP_PREFIX = 'restura-harness-eval-';
const TEMP_WORKTREE_RE = /(?:^|\/)restura-harness-eval-[^/]+\/worktree$/;

const ORIGINS = ['real', 'synthetic'];
const SEAMS = ['cross-branch', 'cross-harness', 'cross-consumer'];
const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const SPLITS = ['train', 'test'];
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
    model: undefined,
    judgeModel: DEFAULT_JUDGE_MODEL,
    judgeRepeat: 1,
    harnessRef: 'HEAD',
    split: 'all',
    saveBaseline: false,
    maxBudgetUsd: 20,
    compare: undefined,
  };
  const valued = [
    '--case',
    '--runs',
    '--config',
    '--out',
    '--model',
    '--judge-model',
    '--judge-repeat',
    '--harness-ref',
    '--split',
    '--max-budget-usd',
    '--compare',
  ];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const name = arg.split('=')[0];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--cleanup') options.cleanup = true;
    else if (arg === '--no-judge') options.judge = false;
    else if (arg === '--save-baseline') options.saveBaseline = true;
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
      else if (name === '--model') options.model = value;
      else if (name === '--judge-model') options.judgeModel = value;
      else if (name === '--judge-repeat') {
        const repeat = Number(value);
        if (!Number.isInteger(repeat) || repeat < 1 || repeat > 3)
          throw new Error('--judge-repeat must be an integer from 1 to 3');
        options.judgeRepeat = repeat;
      } else if (name === '--harness-ref') {
        if (value.startsWith('-') || /\s/.test(value))
          throw new Error('--harness-ref must be a git ref or commit');
        options.harnessRef = value;
      } else if (name === '--split') {
        if (![...SPLITS, 'all'].includes(value))
          throw new Error('--split must be train, test or all');
        options.split = value;
      } else if (name === '--compare') options.compare = value;
      else {
        const budget = Number(value);
        if (!(budget > 0)) throw new Error('--max-budget-usd must be a positive number');
        options.maxBudgetUsd = budget;
      }
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.saveBaseline && options.dryRun)
    throw new Error('--save-baseline needs a real run (a dry run has nothing to record)');
  return options;
}

/** A judge grading its own model's review inflates agreement; warn when they match. */
export function judgeModelWarning({ model, judgeModel }) {
  if (!model || !judgeModel || model !== judgeModel) return null;
  return `warning: the judge model (${judgeModel}) is the model under test; grades may be biased. Pass a different --judge-model.`;
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
  if (!SPLITS.includes(raw.split)) errors.push(`split must be one of ${SPLITS.join('|')}`);
  if (raw.sourcePRs !== undefined && !isStringArray(raw.sourcePRs))
    errors.push('sourcePRs must be a list of strings');
  if (raw.origin === 'real' && !(isStringArray(raw.sourcePRs) && raw.sourcePRs.length > 0))
    errors.push('real cases must cite sourcePRs');
  if (raw.fixPRs !== undefined && !isStringArray(raw.fixPRs))
    errors.push('fixPRs must be a list of strings');
  if (typeof raw.base !== 'string' || !SHA_RE.test(raw.base))
    errors.push('base must be a full 40-character commit SHA');
  if (
    raw.sourceCommit !== undefined &&
    (typeof raw.sourceCommit !== 'string' || !SHA_RE.test(raw.sourceCommit))
  )
    errors.push(
      'sourceCommit must be a full 40-character commit SHA (the patch is base..sourceCommit)'
    );

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
      split: raw.split,
      expectClean,
      sourcePRs: raw.sourcePRs ?? [],
      fixPRs: raw.fixPRs ?? [],
      sourceCommit: raw.sourceCommit ?? null,
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

/**
 * Load and validate every case (or the named ones, within `split`). Throws on
 * any invalid case, whatever the filter.
 */
export function loadCases({
  casesDir = CASES_DIR,
  fixturesDir = FIXTURES_DIR,
  ids = [],
  split = 'all',
} = {}) {
  const all = loadAllCases(casesDir, fixturesDir);
  const inSplit = split === 'all' ? all : all.filter((c) => c.split === split);
  if (ids.length === 0) return inSplit;
  const unknown = ids.filter((id) => !all.some((c) => c.id === id));
  if (unknown.length > 0) throw new Error(`Unknown case(s): ${unknown.join(', ')}`);
  const outside = ids.filter((id) => !inSplit.some((c) => c.id === id));
  if (outside.length > 0) throw new Error(`Case(s) not in split ${split}: ${outside.join(', ')}`);
  return inSplit.filter((c) => ids.includes(c.id));
}

function loadAllCases(casesDir, fixturesDir) {
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
  return cases;
}

// ---------------------------------------------------------------- prompts

/**
 * The review prompt: the harness's real entry point, plus plumbing that
 * points it at the effective base (the harness overlay commit on top of the
 * case base) instead of `main`. Pointing it at the raw case base would put
 * the overlay itself in every diff. It is identical for defect and control
 * cases and never hints at the expected outcome.
 */
export function buildReviewPrompt(_evalCase, branchRefs, effectiveBase) {
  if (typeof effectiveBase !== 'string' || !SHA_RE.test(effectiveBase))
    throw new Error('buildReviewPrompt needs the effective base (the harness overlay commit)');
  return [
    `/ship-check --quick ${branchRefs.join(' ')}`,
    '',
    `Eval harness note: these branches were cut from commit ${effectiveBase}. Treat that commit as`,
    '`main`/`origin/main` for every diff and gate (e.g. `git diff <base>...<branch>`, and',
    `\`npm run integration-check -- --base ${effectiveBase} --no-fetch <branches>\`).`,
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
  return shapeResult(parsed);
}

/** The fields both output formats report, from a `result` envelope/event. */
function shapeResult(parsed) {
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

/**
 * Parse `claude -p --output-format stream-json --verbose` (one JSON event per
 * line). Returns the parseClaudeJson shape, taken from the final `result`
 * event, plus `toolStats`: every tool_use the session made, the Skill names
 * and the Task/Agent subagent types, in order. That is the routing signal:
 * did the review actually run the skills and agents the harness promises?
 * Unparseable lines (a truncated tail) are skipped; a missing result throws.
 */
export function parseClaudeStream(stdout) {
  let result = null;
  const toolStats = { toolCalls: 0, skills: [], agents: [] };
  for (const line of String(stdout ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'result') result = event;
    const content = event.type === 'assistant' ? event.message?.content : null;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_use') continue;
      toolStats.toolCalls += 1;
      const input = block.input ?? {};
      if (block.name === 'Skill' && typeof input.skill === 'string')
        toolStats.skills.push(input.skill);
      if (
        (block.name === 'Task' || block.name === 'Agent') &&
        typeof input.subagent_type === 'string'
      )
        toolStats.agents.push(input.subagent_type);
    }
  }
  if (!result) throw new Error('no result event in claude stream-json output');
  return { ...shapeResult(result), toolStats };
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stripQuotes = (token) => token.replace(/^['"]|['"]$/g, '');
const within = (p, root) => p === root || p.startsWith(`${root.replace(/\/+$/, '')}/`);

function stringsIn(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out);
  else if (value && typeof value === 'object')
    for (const v of Object.values(value)) stringsIn(v, out);
  return out;
}

/** Git dir/worktree targets named in a shell command: -C, --git-dir, --work-tree, GIT_DIR=. */
function gitTargets(command) {
  const targets = [];
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean).map(stripQuotes);
    for (const token of tokens) {
      const env = /^GIT_(?:DIR|WORK_TREE)=(.+)$/.exec(token);
      if (env) targets.push(stripQuotes(env[1]));
    }
    const at = tokens.indexOf('git');
    if (at === -1) continue;
    for (let i = at + 1; i < tokens.length; i += 1) {
      const token = tokens[i];
      const inline = /^--(?:git-dir|work-tree)=(.+)$/.exec(token);
      if (inline) targets.push(stripQuotes(inline[1]));
      else if (['-C', '--git-dir', '--work-tree'].includes(token) && tokens[i + 1])
        targets.push(tokens[i + 1]);
    }
  }
  return targets;
}

/**
 * Did the review reach outside its isolated repo? Scans every tool_use INPUT
 * in a stream-json transcript (tool results are ignored, and node_modules
 * symlinks only count when a path is named explicitly) for (a) an explicit
 * reference to a forbidden root (the main checkout, its realpath) on a path
 * boundary, so `/x/restura-other` does not match `/x/restura`; and (b) git
 * `-C` / `--git-dir` / `--work-tree` / `GIT_DIR=` targets outside
 * `isolatedRoot` (string or list; absolute targets elsewhere, or relative
 * ones climbing with `..`). Without `isolatedRoot` only (a) applies.
 * @param {string} streamText
 * @param {{ forbiddenRoots?: string[]; isolatedRoot?: string | string[] }} [options]
 */
export function detectContamination(streamText, { forbiddenRoots = [], isolatedRoot } = {}) {
  const roots = [...new Set(forbiddenRoots.filter(Boolean).map((r) => r.replace(/\/+$/, '')))];
  const rootRes = roots.map((root) => new RegExp(`${escapeRe(root)}(?![A-Za-z0-9._-])`));
  const allowed = [isolatedRoot ?? []].flat().filter(Boolean);
  const hits = [];
  for (const line of String(streamText ?? '').split('\n')) {
    let event;
    try {
      event = JSON.parse(line.trim());
    } catch {
      continue;
    }
    const content = event?.type === 'assistant' ? event.message?.content : null;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_use') continue;
      const tool = String(block.name ?? '?');
      const texts = stringsIn(block.input ?? {});
      let hit = null;
      for (const text of texts) {
        const match = rootRes.map((re) => re.exec(text)).find(Boolean);
        if (match) {
          const start = Math.max(0, match.index - 40);
          hit = text.slice(start, match.index + match[0].length + 80);
          break;
        }
        if (allowed.length === 0) continue;
        const escape = gitTargets(text).find((target) =>
          path.isAbsolute(target)
            ? !allowed.some((root) => within(path.resolve(target), root))
            : target.split('/').includes('..')
        );
        if (escape) {
          hit = text.slice(0, 160);
          break;
        }
      }
      if (hit !== null) hits.push({ tool, snippet: hit });
    }
  }
  return { contaminated: hits.length > 0, hits };
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
 * @param {(stdout: string) => any} [parse] parseClaudeJson (default) or parseClaudeStream
 */
export function classifyClaudeRun(run, parse = parseClaudeJson) {
  const stderr = (run.stderr ?? '').trim();
  const firstLine = (text) => text.split('\n').find(Boolean)?.slice(0, 200) ?? '';
  if (run.signal) return { status: 'error', reason: `claude killed by signal ${run.signal}` };
  if (run.status !== 0)
    return { status: 'error', reason: `claude exited ${run.status}: ${firstLine(stderr)}` };
  for (const [re, label] of STDERR_ERRORS)
    if (re.test(stderr)) return { status: 'error', reason: `${label}: ${firstLine(stderr)}` };
  let parsed;
  try {
    parsed = parse(run.stdout);
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

/**
 * Combine repeated judge verdicts on ONE review: caught on a strict majority
 * (a tie is not caught), mean score, and whether the judge disagreed with
 * itself (grader inconsistency, reported separately from reviewer flips).
 */
export function majorityVerdict(verdicts) {
  const yes = verdicts.filter((v) => v.caught).length;
  const caught = yes * 2 > verdicts.length;
  const score =
    Math.round((verdicts.reduce((sum, v) => sum + v.score, 0) / verdicts.length) * 100) / 100;
  const reason = (verdicts.find((v) => v.caught === caught) ?? verdicts[0])?.reason ?? '';
  return {
    caught,
    score,
    reason,
    verdicts,
    disagreement: yes > 0 && yes < verdicts.length,
  };
}

// ---------------------------------------------------------------- reporting

const scored = (run) => run.status !== 'error';
const round = (value, places = 2) =>
  value === null || value === undefined ? null : Math.round(value * 10 ** places) / 10 ** places;

function choose(n, k) {
  if (k < 0 || k > n) return 0;
  let out = 1;
  for (let i = 1; i <= k; i += 1) out = (out * (n - k + i)) / i;
  return out;
}

/** Unbiased pass@k from n scored runs with c successes: 1 - C(n-c,k)/C(n,k). */
export function passAtK(n, c, k) {
  if (!(n > 0) || !(k > 0) || k > n) return null;
  return 1 - choose(n - c, k) / choose(n, k);
}

/** Unbiased pass^k (all k succeed) from n scored runs with c successes: C(c,k)/C(n,k). */
export function passHatK(n, c, k) {
  if (!(n > 0) || !(k > 0) || k > n) return null;
  return choose(c, k) / choose(n, k);
}

/** Wilson score interval (95% by default) for a proportion; null when n is 0. */
export function wilsonInterval(successes, n, z = 1.96) {
  if (!(n > 0)) return null;
  const p = successes / n;
  const z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  const low = Math.max(0, centre - margin);
  const high = Math.min(1, centre + margin);
  return { low, high, halfWidth: (high - low) / 2 };
}

const runCost = (run) => {
  const parts = [run.review?.costUsd, run.judgeCostUsd].filter((v) => typeof v === 'number');
  return parts.length === 0 ? null : parts.reduce((a, b) => a + b, 0);
};
const runMinutes = (run) =>
  typeof run.review?.durationMs === 'number' ? run.review.durationMs / 60000 : null;
const mean = (values) =>
  values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;

/** How often each skill / subagent ran: runs it appeared in, and total calls. */
function aggregateToolStats(runs) {
  const out = { runs: 0, toolCalls: 0, skills: {}, agents: {} };
  for (const run of runs) {
    const stats = run.review?.toolStats;
    if (!stats) continue;
    out.runs += 1;
    out.toolCalls += stats.toolCalls ?? 0;
    for (const [key, names] of [
      ['skills', stats.skills ?? []],
      ['agents', stats.agents ?? []],
    ]) {
      for (const name of new Set(names)) (out[key][name] ??= { runs: 0, calls: 0 }).runs += 1;
      for (const name of names) out[key][name].calls += 1;
    }
  }
  return out;
}

/**
 * Per-case results across repeated runs (pass@k / pass^k with k = scored
 * runs, judge self-disagreements, mean cost and minutes), defect recall and
 * control precision with Wilson 95% CIs, totals, a noise line and the
 * skill/agent routing aggregate.
 */
export function summarise(runs) {
  const byCase = {};
  for (const run of runs) {
    const entry = (byCase[run.caseId] ??= {
      expectClean: run.expectClean === true,
      runs: 0,
      caught: 0,
      errors: 0,
      scores: [],
      judgeDisagreements: 0,
      costs: [],
      minutes: [],
    });
    const cost = runCost(run);
    if (cost !== null) entry.costs.push(cost);
    const minutes = runMinutes(run);
    if (minutes !== null) entry.minutes.push(minutes);
    if (!scored(run)) {
      entry.errors += 1;
      continue;
    }
    entry.runs += 1;
    if (run.caught) entry.caught += 1;
    if (run.judgeDisagreement === true) entry.judgeDisagreements += 1;
    if (typeof run.judge?.score === 'number') entry.scores.push(run.judge.score);
  }
  const cases = {};
  const recall = { caught: 0, runs: 0 };
  const controls = { clean: 0, falsePositives: 0, runs: 0 };
  let errors = 0;
  let judgeDisagreements = 0;
  for (const [caseId, entry] of Object.entries(byCase)) {
    errors += entry.errors;
    judgeDisagreements += entry.judgeDisagreements;
    cases[caseId] = {
      expectClean: entry.expectClean,
      runs: entry.runs,
      caught: entry.caught,
      errors: entry.errors,
      flipped: entry.caught > 0 && entry.caught < entry.runs,
      meanScore: round(mean(entry.scores)),
      // pass@1 = c/n, the per-trial rate: comparable across invocations with different run counts.
      passAt1: round(passAtK(entry.runs, entry.caught, 1), 4),
      passAtK: round(passAtK(entry.runs, entry.caught, entry.runs), 4),
      passHatK: round(passHatK(entry.runs, entry.caught, entry.runs), 4),
      judgeDisagreements: entry.judgeDisagreements,
      meanCostUsd: round(mean(entry.costs)),
      meanMinutes: round(mean(entry.minutes)),
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
  recall.rate = recall.runs > 0 ? recall.caught / recall.runs : null;
  recall.ci = wilsonInterval(recall.caught, recall.runs);
  controls.rate = controls.runs > 0 ? controls.clean / controls.runs : null;
  controls.ci = wilsonInterval(controls.clean, controls.runs);
  const totals = {
    costUsd: round(runs.reduce((sum, r) => sum + (runCost(r) ?? 0), 0)),
    minutes: round(runs.reduce((sum, r) => sum + (runMinutes(r) ?? 0), 0)),
    runs: runs.length,
  };
  const noise = {
    flippedCases: Object.values(cases).filter((c) => c.flipped).length,
    recallHalfWidth: recall.ci?.halfWidth ?? null,
  };
  // Mean per-case pass@1 (each case weighs the same, whatever its run count).
  const meanPassAt1 = (clean) =>
    round(
      mean(
        Object.values(cases)
          .filter((c) => c.expectClean === clean && c.passAt1 !== null)
          .map((c) => c.passAt1)
      ),
      4
    );
  return {
    cases,
    recall,
    controls,
    passAt1: { defects: meanPassAt1(false), controls: meanPassAt1(true) },
    errors,
    judgeDisagreements,
    totals,
    noise,
    toolStats: aggregateToolStats(runs),
  };
}

/** Per-case summaries from a full result (`runs`) or a committed baseline (`cases`). */
function caseSummaries(resultOrBaseline) {
  if (Array.isArray(resultOrBaseline?.runs)) return summarise(resultOrBaseline.runs).cases;
  return resultOrBaseline?.cases ?? {};
}

/**
 * Cases whose caught rate (over scored runs) changed between two invocations.
 * Either side may be a full result or a summary-only baseline.
 */
export function diffFlips(previous, current) {
  const before = caseSummaries(previous);
  const after = caseSummaries(current);
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

/**
 * The committed, summary-only form of a result: configuration, per-case
 * summary and the headline rates with CIs. No review text, judge reasons or
 * transcripts, so it is safe to check in.
 */
export function buildBaseline(result) {
  const summary = summarise(result.runs);
  return {
    kind: 'harness-eval-baseline',
    config: result.config,
    harnessSha: result.harnessSha ?? null,
    startedAt: result.startedAt,
    runsPerCase: result.runsPerCase,
    model: result.model ?? null,
    judgeModel: result.judgeModel ?? null,
    judgeRepeat: result.judgeRepeat ?? 1,
    split: result.split ?? 'all',
    cases: summary.cases,
    recall: summary.recall,
    controls: summary.controls,
    passAt1: summary.passAt1,
    errors: summary.errors,
    judgeDisagreements: summary.judgeDisagreements,
    totals: summary.totals,
    noise: summary.noise,
    toolStats: summary.toolStats,
  };
}

/**
 * Where `--save-baseline` writes: `<dir>/<YYYY-MM-DD>T<HHMM>--<config>.json`
 * (UTC, from startedAt), so same-day runs of one config never collide.
 */
export function baselinePath(result, dir = BASELINES_DIR) {
  const iso = new Date(result.startedAt).toISOString();
  const stamp = `${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}`;
  return path.join(dir, `${stamp}--${result.config}.json`);
}

/** Write the baseline; refuses to overwrite an existing file. Returns its path. */
export function writeBaseline(result, dir = BASELINES_DIR) {
  const file = baselinePath(result, dir);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(file, `${JSON.stringify(buildBaseline(result), null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    if (error?.code === 'EEXIST')
      throw new Error(`baseline ${file} already exists; not overwriting`);
    throw error;
  }
  return file;
}

const cell = (value) =>
  String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const pct = (value) =>
  value === null || value === undefined ? 'n/a' : `${Math.round(value * 100)}%`;
const ciText = (ci) => (ci ? `95% CI ${pct(ci.low)}-${pct(ci.high)}` : '95% CI n/a');
const fixed = (value, places) =>
  value === null || value === undefined ? 'n/a' : value.toFixed(places);

function harnessLine(result) {
  const parts = [];
  if (result.harnessSha)
    parts.push(
      `Harness ${result.harnessSha.slice(0, 12)}${result.harnessRef ? ` (${result.harnessRef})` : ''}, overlaid on every case base`
    );
  if (!result.dryRun) {
    parts.push(`reviewer model ${result.model ?? 'CLI default'}`);
    parts.push(
      `judge ${result.judgeModel ?? 'CLI default'}${(result.judgeRepeat ?? 1) > 1 ? ` x${result.judgeRepeat}` : ''}`
    );
  }
  if (result.split && result.split !== 'all') parts.push(`split ${result.split}`);
  return parts.length > 0 ? `${parts.join('; ')}.` : null;
}

export function formatSummaryMarkdown(result, flips, comparedTo) {
  const lines = [
    `# Harness eval: ${result.config}`,
    '',
    `Started ${result.startedAt}${result.dryRun ? ' (dry run: no model calls)' : ''}.`,
  ];
  const harness = harnessLine(result);
  if (harness) lines.push(harness);
  lines.push('');
  if (result.dryRun) {
    lines.push('| case | patches apply | combined merge | error |', '|---|---|---|---|');
    for (const run of result.runs)
      lines.push(
        `| ${run.caseId} | ${run.applied ? 'yes' : 'NO'} | ${run.combinedMerge ?? ''} | ${cell(run.reason)} |`
      );
    return `${lines.join('\n')}\n`;
  }
  const summary = summarise(result.runs);
  const { recall, controls, noise, totals } = summary;
  lines.push(
    `Recall on defect cases: ${recall.caught}/${recall.runs} scored runs caught the seam defect (${pct(recall.rate)}, ${ciText(recall.ci)}).`,
    `Controls: ${controls.clean}/${controls.runs} clean, ${plural(controls.falsePositives, 'false positive')} (precision ${pct(controls.rate)}, ${ciText(controls.ci)}).`,
    `Harness errors (excluded from both): ${summary.errors}. Judge self-disagreements: ${summary.judgeDisagreements}.`,
    `Noise: ${plural(noise.flippedCases, 'case')} flipped within this invocation; recall CI half-width ±${noise.recallHalfWidth === null ? 'n/a' : `${Math.round(noise.recallHalfWidth * 100)} pts`}. Do not act on a config difference smaller than the half-width; add runs or cases.`,
    `pass@1 (per-trial rate): defects ${pct(summary.passAt1.defects)}, controls ${pct(summary.passAt1.controls)} (mean over cases; compare this across invocations with different run counts).`,
    `Totals: $${fixed(totals.costUsd, 2)} and ${fixed(totals.minutes, 1)} min over ${plural(totals.runs, 'run')} (review + judge).`,
    '',
    '"caught" for a control means the review reported no high/medium defect in its files. ' +
      "pass@1 is the per-trial rate c/n; pass@n / pass^n use n = the case's scored runs " +
      '(pass@n: at least one run caught it; pass^n: every run did). ' +
      'judge-only / pattern-only count scored runs where just one grader said caught.',
    ''
  );
  const ns = [...new Set(Object.values(summary.cases).map((c) => c.runs))];
  const nLabel = ns.length === 1 ? String(ns[0]) : 'n';
  const withN = (value, n) => (ns.length === 1 ? fixed(value, 2) : `${fixed(value, 2)} (n=${n})`);
  lines.push(
    `| case | type | caught | errors | flipped | pass@1 | pass@${nLabel} | pass^${nLabel} | mean judge score | judge-only | pattern-only | judge disagreements | mean cost USD | mean minutes | transcripts |`,
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'
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
    const transcripts =
      runs
        .filter((r) => r.transcript)
        .map((r) => `[${r.run}](${r.transcript})`)
        .join(' ') || 'none';
    lines.push(
      `| ${caseId} | ${entry.expectClean ? 'control' : 'defect'} | ${entry.caught}/${entry.runs} | ${entry.errors} | ${entry.flipped ? 'YES' : 'no'} | ${fixed(entry.passAt1, 2)} | ${withN(entry.passAtK, entry.runs)} | ${withN(entry.passHatK, entry.runs)} | ${entry.meanScore ?? 'n/a'} | ${judgeOnly} | ${patternOnly} | ${entry.judgeDisagreements} | ${fixed(entry.meanCostUsd, 2)} | ${fixed(entry.meanMinutes, 1)} | ${transcripts} |`
    );
  }
  const { toolStats } = summary;
  if (toolStats.runs > 0) {
    lines.push(
      '',
      `## Routing (skills and subagents across ${plural(toolStats.runs, 'review run')}, ${toolStats.toolCalls} tool calls)`,
      ''
    );
    const routed = [
      ...Object.entries(toolStats.skills).map(([name, s]) => ['skill', name, s]),
      ...Object.entries(toolStats.agents).map(([name, s]) => ['agent', name, s]),
    ];
    if (routed.length === 0) lines.push('No Skill or Task/Agent calls were made.');
    else {
      lines.push('| kind | name | runs | calls |', '|---|---|---|---|');
      for (const [kind, name, s] of routed)
        lines.push(`| ${kind} | ${cell(name)} | ${s.runs}/${toolStats.runs} | ${s.calls} |`);
    }
  }
  const errored = result.runs.filter((r) => !scored(r));
  if (errored.length > 0) {
    lines.push('', '## Harness errors (not counted as misses)', '');
    for (const run of errored) {
      lines.push(`- ${run.caseId} run ${run.run}: ${cell(run.reason)}`);
      for (const hit of run.contamination ?? [])
        lines.push(`  - ${hit.tool}: \`${cell(hit.snippet).replace(/`/g, "'")}\``);
    }
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
  /**
   * `from | to` without a shell: both are argv arrays ([command, args]). The
   * status is the first non-zero exit (producer first), stderr is both.
   */
  pipe(from, to, opts = {}) {
    return new Promise((resolve) => {
      const producer = spawn(from[0], from[1], {
        cwd: opts.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const consumer = spawn(to[0], to[1], { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const codes = {};
      producer.stdout.pipe(consumer.stdin);
      consumer.stdin.on('error', () => {});
      for (const child of [producer, consumer]) {
        child.stderr.setEncoding('utf8').on('data', (d) => {
          stderr += d;
        });
        child.on('error', (error) => {
          stderr += String(error);
        });
      }
      consumer.stdout.setEncoding('utf8').on('data', (d) => {
        stdout += d;
      });
      const done = () => {
        if (!('producer' in codes && 'consumer' in codes)) return;
        const status = codes.producer !== 0 ? (codes.producer ?? 1) : (codes.consumer ?? 1);
        resolve({ status, stdout, stderr });
      };
      producer.on('close', (code) => {
        codes.producer = code;
        done();
      });
      consumer.on('close', (code) => {
        codes.consumer = code;
        done();
      });
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

async function mustPipe(exec, from, to, what) {
  const result = await exec.pipe(from, to);
  if (result.status !== 0)
    throw new Error(`${what} failed: ${(result.stderr || result.stdout || '').trim()}`);
  return result;
}

async function must(exec, args, what, opts) {
  const result = await (opts ? exec.run('git', args, opts) : exec.run('git', args));
  if (result.status !== 0)
    throw new Error(`${what} failed: ${(result.stderr || result.stdout || '').trim()}`);
  return result;
}

/**
 * Merge ONLY the harness script keys (HARNESS_SCRIPT_KEYS) from the harness
 * package.json into the base's. Everything else of the base is kept; when
 * nothing changes the base text is returned byte-for-byte, otherwise it is
 * re-serialised as 2-space JSON with a trailing newline (the repo's format).
 */
export function mergePackageScripts(baseText, harnessText) {
  let base;
  let harness;
  try {
    base = JSON.parse(baseText);
    harness = JSON.parse(harnessText);
  } catch {
    return baseText;
  }
  if (!base || typeof base !== 'object' || !harness || typeof harness !== 'object') return baseText;
  let changed = false;
  for (const key of HARNESS_SCRIPT_KEYS) {
    const value = harness.scripts?.[key];
    if (typeof value !== 'string' || base.scripts?.[key] === value) continue;
    base.scripts = base.scripts ?? {};
    base.scripts[key] = value;
    changed = true;
  }
  return changed ? `${JSON.stringify(base, null, 2)}\n` : baseText;
}

/**
 * Replace the case base's harness with the one at `harnessSha` and commit it,
 * so the review runs the skills, agents, hooks, CLAUDE.md and review scripts
 * under test rather than whatever the (often months-old) case base shipped.
 * The worktree must be checked out at the case base. Returns the overlay
 * commit (`effectiveBase`): branches are cut from it and the review treats it
 * as `main`.
 * @param {any} exec
 * @param {string} worktree
 * @param {string} harnessSha
 * @param {{ sourceRepo?: string }} [options] read harness objects from this repo (isolated mode)
 */
export async function overlayHarness(exec, worktree, harnessSha, { sourceRepo } = {}) {
  const git = (args, what, opts) =>
    must(exec, ['-C', worktree, ...args], `harness overlay: ${what}`, opts);
  // Where the harness commit's objects live: the worktree itself (a linked
  // worktree shares them) or, for an isolated repo, the source repo (read only).
  const source = sourceRepo ?? worktree;
  await git(
    ['rm', '-r', '-q', '--ignore-unmatch', '--', ...HARNESS_REMOVE_PATHS],
    'remove base harness'
  );
  const present = [];
  for (const p of HARNESS_OVERLAY_PATHS) {
    const probe = await exec.run('git', ['-C', source, 'cat-file', '-e', `${harnessSha}:${p}`]);
    if (probe.status === 0) present.push(p);
  }
  if (present.length > 0 && sourceRepo) {
    await mustPipe(
      exec,
      ['git', ['-C', sourceRepo, 'archive', harnessSha, '--', ...present]],
      ['tar', ['-x', '-f', '-', '-C', worktree]],
      'harness overlay: extract'
    );
    await git(['add', '-A', '-f', '--', ...present], 'stage');
  } else if (present.length > 0) await git(['checkout', harnessSha, '--', ...present], 'checkout');
  const harnessPkg = await exec.run('git', ['-C', source, 'show', `${harnessSha}:package.json`]);
  const basePkg = await exec.run('git', ['-C', worktree, 'show', 'HEAD:package.json']);
  if (harnessPkg.status === 0 && basePkg.status === 0) {
    const merged = mergePackageScripts(basePkg.stdout, harnessPkg.stdout);
    if (merged !== basePkg.stdout) {
      const blob = (
        await git(['hash-object', '-w', '--stdin'], 'hash package.json', { input: merged })
      ).stdout.trim();
      await git(
        ['update-index', '--cacheinfo', `100644,${blob},package.json`],
        'stage package.json'
      );
      await git(['checkout', '--', 'package.json'], 'write package.json');
    }
  }
  await git(
    [
      ...IDENTITY,
      'commit',
      '-q',
      '--no-verify',
      '--allow-empty',
      '-m',
      `harness overlay @ ${harnessSha.slice(0, 12)}`,
    ],
    'commit'
  );
  const effectiveBase = (await git(['rev-parse', 'HEAD'], 'resolve commit')).stdout.trim();
  if (!SHA_RE.test(effectiveBase))
    throw new Error(`harness overlay: unexpected commit id ${effectiveBase}`);
  return { harnessSha, effectiveBase };
}

/**
 * Build a history-free repo for one run: `git init`, the base TREE (via
 * `git archive`, so no commits, refs or objects from this repo come along),
 * committed as `base`, then the harness overlay committed on top. The review
 * runs here, so `git log --all` / `git show` cannot reach the later fix
 * commits: the answer stays structurally out of the reviewer's reach. `main`
 * and `refs/remotes/origin/main` point at the overlay commit; no remote is
 * configured, so fetch and push fail closed. The source repo is only read.
 * @param {{ run: Function; pipe: Function }} exec
 * @param {{ dir: string; baseSha: string; harnessSha: string; repo: string }} options
 */
export async function createIsolatedRepo(exec, { dir, baseSha, harnessSha, repo }) {
  for (const [name, sha] of [
    ['baseSha', baseSha],
    ['harnessSha', harnessSha],
  ])
    if (typeof sha !== 'string' || !SHA_RE.test(sha))
      throw new Error(`createIsolatedRepo needs a full ${name}`);
  await must(exec, ['-C', repo, 'rev-parse', '--verify', `${baseSha}^{commit}`], 'resolve base');
  await must(exec, ['init', '-q', '--initial-branch=main', dir], 'isolated repo: init');
  await mustPipe(
    exec,
    ['git', ['-C', repo, 'archive', baseSha]],
    ['tar', ['-x', '-f', '-', '-C', dir]],
    'isolated repo: extract base'
  );
  await must(exec, ['-C', dir, 'add', '-A', '-f'], 'isolated repo: stage base');
  await must(
    exec,
    ['-C', dir, ...IDENTITY, 'commit', '-q', '--no-verify', '-m', 'base'],
    'isolated repo: commit base'
  );
  const overlay = await overlayHarness(exec, dir, harnessSha, { sourceRepo: repo });
  await must(
    exec,
    ['-C', dir, 'update-ref', 'refs/remotes/origin/main', overlay.effectiveBase],
    'isolated repo: origin/main'
  );
  return overlay;
}

/** Depth-1 and depth-2 directories of `root` that hold a package.json. */
function packageDirs(root) {
  const found = [];
  const skip = new Set(['node_modules', 'dist', 'coverage']);
  const walk = (relative, depth) => {
    if (depth > 2) return;
    for (const dirent of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (!dirent.isDirectory() || skip.has(dirent.name) || dirent.name.startsWith('.')) continue;
      const child = relative === '.' ? dirent.name : `${relative}/${dirent.name}`;
      if (fs.existsSync(path.join(root, child, 'package.json'))) found.push(child);
      walk(child, depth + 1);
    }
  };
  walk('.', 1);
  return found;
}

/**
 * Symlink the main checkout's node_modules (root + workspaces) into `dir`,
 * like `npm run worktree:setup`, which only accepts linked worktrees. The
 * links are gitignored. Returns the linked (or already linked) dirs.
 */
export function linkNodeModules(dir, mainCheckout) {
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(mainCheckout, 'package.json'), 'utf8'));
  } catch {}
  const dirs = planLinks({
    workspaces: Array.isArray(pkg.workspaces) ? pkg.workspaces : [],
    candidates: packageDirs(mainCheckout),
    mainHasNodeModules: (d) => fs.existsSync(path.join(mainCheckout, d, 'node_modules')),
    worktreeHasPackage: (d) => fs.existsSync(path.join(dir, d, 'package.json')),
  });
  const linked = [];
  for (const d of dirs) {
    const link = path.join(dir, d, 'node_modules');
    const target = path.join(mainCheckout, d, 'node_modules');
    const stat = fs.lstatSync(link, { throwIfNoEntry: false });
    const action = linkAction({
      kind: !stat ? 'missing' : stat.isSymbolicLink() ? 'symlink' : 'other',
      currentTarget: stat?.isSymbolicLink()
        ? path.resolve(path.dirname(link), fs.readlinkSync(link))
        : undefined,
      target,
    });
    if (action === 'create') fs.symlinkSync(target, link, 'dir');
    if (action === 'create' || action === 'ok') linked.push(d);
  }
  return linked;
}

const why = (result) => (result.stderr || result.stdout || `exit ${result.status}`).trim();

/**
 * Cleanup as a strictly ordered sequence of git commands: remove the worktree
 * (a branch still checked out there cannot be deleted), then each branch one
 * at a time (parallel `branch -D` collides on packed-refs.lock), then prune.
 * Whatever fails to go stays in `tracker` and is reported in `failed`.
 */
function* cleanupSteps(repo, tracker, failed) {
  if (tracker.worktree) {
    const result = yield ['-C', repo, 'worktree', 'remove', '--force', tracker.worktree];
    if (result.status === 0) tracker.worktree = null;
    else failed.push(`worktree ${tracker.worktree}: ${why(result)}`);
  }
  const kept = [];
  for (const ref of [...tracker.branches]) {
    const result = yield ['-C', repo, 'branch', '-D', ref];
    if (result.status !== 0) {
      kept.push(ref);
      failed.push(`${ref}: ${why(result)}`);
    }
  }
  tracker.branches.splice(0, tracker.branches.length, ...kept);
  yield ['-C', repo, 'worktree', 'prune'];
}

/** Synchronous cleanup (signal handlers, --cleanup); `exec.run` must return a result, not a promise. */
export function cleanupTracked(exec, repo, tracker) {
  const failed = [];
  const steps = cleanupSteps(repo, tracker, failed);
  let step = steps.next();
  while (!step.done) step = steps.next(exec.run('git', step.value));
  return { failed };
}

/** Same ordered cleanup, awaiting each command before starting the next. */
export async function cleanupTrackedAsync(exec, repo, tracker) {
  const failed = [];
  const steps = cleanupSteps(repo, tracker, failed);
  let step = steps.next();
  while (!step.done) step = steps.next(await exec.run('git', step.value));
  return { failed };
}

/**
 * Build the case's branches in a history-free isolated repo under
 * `ctx.tempDir` (see createIsolatedRepo), optionally review and grade them.
 * Nothing is created in the main repo, so cleanup is removing `tempDir`,
 * which the caller (runEval, or its signal handler) owns.
 * @param {any} evalCase validated case
 * @param {{ exec: { run: Function; pipe: Function }; repo: string; tempDir: string; dryRun: boolean;
 *   harnessSha: string; mainCheckout?: string; forbiddenRoots?: string[]; judge?: boolean; rubric?: string; model?: string;
 *   judgeModel?: string; judgeRepeat?: number; maxBudgetUsd?: number; transcriptFile?: string;
 *   transcriptLink?: string; setup?: (dir: string) => void; runId?: string; tracker?: unknown }} ctx
 */
export async function runCase(evalCase, ctx) {
  const { exec, repo, tempDir } = ctx;
  const worktree = path.join(tempDir, 'repo');
  // Plain branch names: they exist only in the isolated repo.
  const refs = evalCase.branches.map((b) => b.name);
  const outcome = {
    caseId: evalCase.id,
    expectClean: evalCase.expectClean,
    branches: refs,
    applied: false,
    status: 'ok',
  };
  try {
    if (typeof ctx.harnessSha !== 'string' || !SHA_RE.test(ctx.harnessSha))
      throw new Error('runCase needs ctx.harnessSha (the resolved --harness-ref)');
    const { effectiveBase } = await createIsolatedRepo(exec, {
      dir: worktree,
      baseSha: evalCase.base,
      harnessSha: ctx.harnessSha,
      repo,
    });
    outcome.harnessSha = ctx.harnessSha;
    outcome.effectiveBase = effectiveBase;
    for (const [index, branch] of evalCase.branches.entries()) {
      await must(
        exec,
        ['-C', worktree, 'checkout', '-q', '--detach', effectiveBase],
        'checkout base'
      );
      await must(exec, ['-C', worktree, 'checkout', '-q', '-b', refs[index]], 'create branch');
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
      ['-C', worktree, 'checkout', '-q', '--detach', effectiveBase],
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
    (ctx.setup ?? ((dir) => linkNodeModules(dir, ctx.mainCheckout ?? repo)))(worktree);
    const reviewArgs = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--max-budget-usd',
      String(ctx.maxBudgetUsd ?? 20),
      '--permission-mode',
      'dontAsk',
    ];
    if (ctx.model) reviewArgs.push('--model', ctx.model);
    reviewArgs.push(
      '--allowedTools',
      'Bash',
      'Read',
      'Grep',
      'Glob',
      'Task',
      'Skill',
      '--disallowedTools',
      'Bash(git push:*)',
      'Bash(gh:*)'
    );
    const rawReview = await exec.run('claude', reviewArgs, {
      cwd: worktree,
      input: buildReviewPrompt(evalCase, refs, effectiveBase),
      timeout: REVIEW_TIMEOUT_MS,
    });
    if (ctx.transcriptFile) {
      // Written before classification so errored runs keep their transcript too.
      fs.mkdirSync(path.dirname(ctx.transcriptFile), { recursive: true });
      fs.writeFileSync(ctx.transcriptFile, rawReview.stdout ?? '');
      outcome.transcript = ctx.transcriptLink ?? ctx.transcriptFile;
    }
    const reviewRun = classifyClaudeRun(rawReview, parseClaudeStream);
    if (reviewRun.parsed) outcome.review = reviewRun.parsed;
    if (reviewRun.status === 'error') throw new Error(`review: ${reviewRun.reason}`);
    if (ctx.forbiddenRoots?.length) {
      let real = worktree;
      try {
        real = fs.realpathSync(worktree);
      } catch {}
      const contamination = detectContamination(rawReview.stdout, {
        forbiddenRoots: ctx.forbiddenRoots,
        isolatedRoot: [worktree, real],
      });
      if (contamination.contaminated) {
        // Excluded from scoring: the review may have read the answer from this repo's history.
        outcome.contamination = contamination.hits;
        throw new Error(
          `contaminated: ${plural(contamination.hits.length, 'tool call')} reached outside the isolated repo (${contamination.hits.map((h) => h.tool).join(', ')})`
        );
      }
    }
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
        '--model',
        ctx.judgeModel ?? DEFAULT_JUDGE_MODEL,
      ];
      const repeat = ctx.judgeRepeat ?? 1;
      const verdicts = [];
      let judgeCost = null;
      for (let attempt = 1; attempt <= repeat; attempt += 1) {
        const judgeRun = classifyClaudeRun(
          await exec.run('claude', judgeArgs, {
            cwd: tempDir,
            input: buildJudgePrompt({ rubric: ctx.rubric ?? '', evalCase, reviewText }),
            timeout: JUDGE_TIMEOUT_MS,
          })
        );
        if (judgeRun.status === 'error') throw new Error(`judge: ${judgeRun.reason}`);
        if (typeof judgeRun.parsed.costUsd === 'number')
          judgeCost = (judgeCost ?? 0) + judgeRun.parsed.costUsd;
        try {
          verdicts.push(parseJudgeVerdict(judgeRun.parsed.text));
        } catch (error) {
          throw new Error(`judge: ${error.message}`);
        }
      }
      outcome.judgeCostUsd = judgeCost;
      const { disagreement, ...majority } = majorityVerdict(verdicts);
      outcome.judge = majority;
      outcome.judgeDisagreement = disagreement;
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
  // node_modules are linked from the main checkout (this script may run in a linked worktree).
  const commonDir = (
    await exec.run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: ROOT,
    })
  ).stdout.trim();
  const mainCheckout = commonDir ? path.dirname(commonDir) : repo;
  // Explicit references to these in a review's tool inputs mark the run contaminated.
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
  const cases = loadCases({ ids: options.caseIds, split: options.split ?? 'all' });
  const rubric = options.dryRun ? '' : fs.readFileSync(RUBRIC_PATH, 'utf8');
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, '-');
  const runs = options.dryRun ? 1 : options.runs;
  // Resolve the harness under test ONCE so every case and run overlays the same commit.
  const harnessRef = options.harnessRef ?? 'HEAD';
  const resolved = await exec.run('git', ['rev-parse', '--verify', `${harnessRef}^{commit}`], {
    cwd: ROOT,
  });
  const harnessSha = resolved.stdout.trim();
  if (resolved.status !== 0 || !SHA_RE.test(harnessSha))
    throw new Error(`--harness-ref ${harnessRef} does not resolve to a commit`);
  const judgeModel = options.judgeModel ?? DEFAULT_JUDGE_MODEL;
  const judgeRepeat = options.judgeRepeat ?? 1;
  const warning = options.dryRun ? null : judgeModelWarning({ model: options.model, judgeModel });
  if (warning) log(warning);
  const result = {
    config: options.config,
    startedAt,
    dryRun: options.dryRun,
    harnessRef,
    harnessSha,
    model: options.model ?? null,
    judgeModel: options.judge === false ? null : judgeModel,
    judgeRepeat,
    split: options.split ?? 'all',
    runsPerCase: runs,
    runs: [],
  };
  const outDir = path.resolve(ROOT, options.out);
  const base = path.join(outDir, `${stamp}${options.dryRun ? '--dry-run' : ''}--${options.config}`);
  const transcriptsDir = path.join(base, 'transcripts');
  // Fail before spending money if the baseline this run would write already exists.
  if (options.saveBaseline && !options.dryRun && fs.existsSync(baselinePath(result)))
    throw new Error(`baseline ${baselinePath(result)} already exists; not overwriting`);

  // Ctrl-C / kill mid-run: stop the child, remove this run's temp dir (the
  // isolated repo lives inside it; the main repo is never mutated), exit non-zero.
  let tempDir = null;
  const onSignal = (signal) => {
    activeChild?.kill('SIGTERM');
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    console.error(`\nharness-eval: ${signal}; removed this run's isolated repo.`);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    log(
      `${options.dryRun ? 'Dry run of' : 'Running'} ${cases.length} case(s) x ${runs} run(s) with config "${options.config}", harness ${harnessSha.slice(0, 12)} (${harnessRef}).`
    );
    for (const evalCase of cases) {
      for (let run = 1; run <= runs; run += 1) {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${TEMP_PREFIX}${evalCase.id}-`));
        log(`${evalCase.id} run ${run}/${runs}…`);
        const transcriptName = `${evalCase.id}-run${run}.jsonl`;
        const outcome = await runCase(evalCase, {
          exec,
          repo,
          tempDir,
          dryRun: options.dryRun,
          harnessSha,
          mainCheckout,
          forbiddenRoots,
          judge: options.judge,
          rubric,
          model: options.model,
          judgeModel,
          judgeRepeat,
          maxBudgetUsd: options.maxBudgetUsd,
          transcriptFile: options.dryRun ? undefined : path.join(transcriptsDir, transcriptName),
          transcriptLink: `${path.basename(base)}/transcripts/${transcriptName}`,
        });
        fs.rmSync(tempDir, { recursive: true, force: true });
        tempDir = null;
        result.runs.push({ run, origin: evalCase.origin, split: evalCase.split, ...outcome });
        log(
          options.dryRun
            ? `  overlay ${outcome.effectiveBase ? outcome.effectiveBase.slice(0, 12) : 'FAIL'}; patches ${outcome.applied ? 'apply' : 'FAIL'}; combined merge ${outcome.combinedMerge ?? 'n/a'}${outcome.reason ? `; ${outcome.reason}` : ''}`
            : outcome.status === 'error'
              ? `  harness error: ${outcome.reason}`
              : `  caught=${outcome.caught} (judge=${outcome.judgeCaught}, pattern=${outcome.patternCaught})`
        );
        if (outcome.cleanupFailed)
          log(
            `  cleanup left: ${outcome.cleanupFailed.join('; ')} (retried next run; or --cleanup)`
          );
      }
    }
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  fs.mkdirSync(outDir, { recursive: true });
  let flips;
  let comparedTo;
  if (!options.dryRun) {
    // Either a full result or a committed baseline (diffFlips accepts both).
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
  if (options.saveBaseline && !options.dryRun) {
    const file = writeBaseline(result);
    log(`Wrote baseline ${path.relative(ROOT, file)} (summary only; commit it)`);
  }
  const failed =
    result.runs.some((r) => r.cleanupFailed) ||
    (options.dryRun
      ? result.runs.some((r) => !r.applied || r.combinedMerge !== 'clean')
      : result.runs.some((r) => r.status === 'error'));
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
