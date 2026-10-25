#!/usr/bin/env node
// Routing eval: for a realistic prompt, does the agent load the right skill or
// subagent, and leave the wrong ones alone?
//
// Cases live in evals/routing/cases.yaml. Each run takes a history-free
// snapshot of the harness ref (`git archive <ref>` into a temp dir, then a
// fresh one-commit repo, so the model cannot read git history for hints),
// runs `claude -p --output-format stream-json --verbose --max-turns 3` there
// with read-only tools (Read Grep Glob Skill Task; Edit Write Bash
// disallowed), parses the stream with parseClaudeStream and grades
// deterministically from toolStats: a run passes when at least one expected
// skill/agent ran (positive cases) and no forbidden one did. No LLM judge.
//
// Usage:
//   npm run eval:routing -- [--case <id>]... [--split train|test|all] [--runs N]
//     [--max-budget-usd <n>] [--model <model>] [--config <label>] [--ref <git-ref>]
//     [--out <dir>] [--dry-run]
//
// --dry-run validates the cases and prints the plan; it makes no model calls.
// A real run costs money (runs x cases x up to --max-budget-usd), so run it
// deliberately. Results: <out>/routing/<timestamp>--<config>.json + .md, plus
// one transcript per run.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { nodeExec, parseClaudeStream, passAtK, passHatK, wilsonInterval } from './harness-eval.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROUTING_CASES_PATH = path.join(ROOT, 'evals/routing/cases.yaml');
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const CONFIG_RE = /^[A-Za-z0-9._-]+$/;
const SPLITS = ['train', 'test'];
const LIST_KEYS = ['expectSkills', 'expectAgents', 'forbidSkills', 'forbidAgents'];
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
// Tools whose denial means the harness, not the model, failed the run.
const ROUTING_TOOLS = new Set(['Skill', 'Task', 'Agent', 'Read', 'Grep', 'Glob']);

// ---------------------------------------------------------------- arguments

export function parseRoutingArgs(argv) {
  const options = {
    caseIds: [],
    split: 'all',
    runs: 2,
    maxBudgetUsd: 1,
    model: null,
    config: 'current',
    ref: 'HEAD',
    out: path.join(ROOT, '.claude/metrics/evals'),
    dryRun: false,
  };
  const valued = [
    '--case',
    '--split',
    '--runs',
    '--max-budget-usd',
    '--model',
    '--config',
    '--ref',
    '--out',
  ];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (!valued.includes(arg)) throw new Error(`unknown argument ${arg}`);
    const value = argv[index + 1];
    index += 1;
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
    if (arg === '--case') options.caseIds.push(value);
    else if (arg === '--split') {
      if (![...SPLITS, 'all'].includes(value)) throw new Error('--split must be train|test|all');
      options.split = value;
    } else if (arg === '--runs') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error('--runs must be 1-20');
      options.runs = n;
    } else if (arg === '--max-budget-usd') {
      const n = Number(value);
      if (!(n > 0)) throw new Error('--max-budget-usd must be a positive budget');
      options.maxBudgetUsd = n;
    } else if (arg === '--model') options.model = value;
    else if (arg === '--config') {
      if (!CONFIG_RE.test(value)) throw new Error('--config must match [A-Za-z0-9._-]+');
      options.config = value;
    } else if (arg === '--ref') options.ref = value;
    else if (arg === '--out') options.out = path.resolve(value);
  }
  return options;
}

// ---------------------------------------------------------------- cases

/** Skills under .claude/skills/<name>/SKILL.md and agents under .claude/agents/<name>.md. */
export function knownRoutingNames(root = ROOT) {
  const skills = new Set();
  const agents = new Set();
  const skillsDir = path.join(root, '.claude/skills');
  const agentsDir = path.join(root, '.claude/agents');
  if (fs.existsSync(skillsDir))
    for (const name of fs.readdirSync(skillsDir))
      if (fs.existsSync(path.join(skillsDir, name, 'SKILL.md'))) skills.add(name);
  if (fs.existsSync(agentsDir))
    for (const file of fs.readdirSync(agentsDir))
      if (file.endsWith('.md')) agents.add(file.slice(0, -3));
  return { skills, agents };
}

/**
 * Validate the parsed cases file. Reports every problem.
 * @param {any} raw parsed YAML ({ cases: [...] })
 * @param {{ skills: Set<string>; agents: Set<string> }} known
 */
export function validateRoutingCases(raw, known) {
  const errors = [];
  const cases = [];
  if (!raw || !Array.isArray(raw.cases)) return { errors: ['cases must be a list'], cases };
  const seen = new Set();
  for (const [index, item] of raw.cases.entries()) {
    const id = typeof item?.id === 'string' ? item.id : `cases[${index}]`;
    const err = (message) => errors.push(`${id}: ${message}`);
    if (typeof item?.id !== 'string' || !ID_RE.test(item.id)) err('id must be kebab-case');
    else if (seen.has(item.id)) err(`duplicate id ${item.id}`);
    else seen.add(item.id);
    if (!SPLITS.includes(item?.split)) err(`split must be one of ${SPLITS.join('|')}`);
    if (typeof item?.prompt !== 'string' || item.prompt.trim() === '') err('prompt is required');
    const lists = {};
    for (const key of LIST_KEYS) {
      const value = item?.[key] ?? [];
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
        err(`${key} must be a list of names`);
        lists[key] = [];
      } else lists[key] = value;
    }
    if (LIST_KEYS.every((key) => lists[key].length === 0))
      err('needs at least one of expectSkills, expectAgents, forbidSkills, forbidAgents');
    for (const key of ['expectSkills', 'forbidSkills'])
      for (const name of lists[key])
        if (!known.skills.has(name)) err(`unknown skill ${name} in ${key}`);
    for (const key of ['expectAgents', 'forbidAgents'])
      for (const name of lists[key])
        if (!known.agents.has(name)) err(`unknown agent ${name} in ${key}`);
    for (const name of lists.expectSkills)
      if (lists.forbidSkills.includes(name)) err(`skill ${name} is both expected and forbidden`);
    for (const name of lists.expectAgents)
      if (lists.forbidAgents.includes(name)) err(`agent ${name} is both expected and forbidden`);
    cases.push({
      id,
      split: item?.split,
      prompt: typeof item?.prompt === 'string' ? item.prompt.trim() : '',
      ...lists,
      kind: lists.expectSkills.length + lists.expectAgents.length > 0 ? 'positive' : 'negative',
    });
  }
  return { errors, cases: errors.length === 0 ? cases : [] };
}

/** Load, validate and filter the committed cases. Throws on any invalid case. */
export function loadRoutingCases({ file = ROUTING_CASES_PATH, split = 'all', caseIds = [] } = {}) {
  const raw = loadYaml(fs.readFileSync(file, 'utf8'));
  const { errors, cases } = validateRoutingCases(raw, knownRoutingNames());
  if (errors.length > 0) throw new Error(`invalid routing cases:\n  ${errors.join('\n  ')}`);
  for (const id of caseIds)
    if (!cases.some((c) => c.id === id)) throw new Error(`unknown routing case ${id}`);
  return cases.filter(
    (c) =>
      (split === 'all' || c.split === split) && (caseIds.length === 0 || caseIds.includes(c.id))
  );
}

// ---------------------------------------------------------------- grading

/**
 * `/ship-check` counts as `ship-check`. A plugin-namespaced skill
 * (`engineering:code-review`) is a different skill and is kept as is.
 */
const normaliseName = (name) => String(name).replace(/^\//, '');

/**
 * Deterministic grade from the run's toolStats.
 * @returns {{ pass: boolean; expectedHit: string[]; forbiddenHit: string[] }}
 */
export function gradeRoutingRun(routingCase, toolStats) {
  const skills = new Set((toolStats?.skills ?? []).map(normaliseName));
  const agents = new Set((toolStats?.agents ?? []).map(normaliseName));
  const hits = (names, invoked, prefix) =>
    (names ?? []).filter((n) => invoked.has(n)).map((n) => `${prefix}:${n}`);
  const expectedHit = [
    ...hits(routingCase.expectSkills, skills, 'skill'),
    ...hits(routingCase.expectAgents, agents, 'agent'),
  ];
  const forbiddenHit = [
    ...hits(routingCase.forbidSkills, skills, 'skill'),
    ...hits(routingCase.forbidAgents, agents, 'agent'),
  ];
  const needsExpected =
    (routingCase.expectSkills?.length ?? 0) + (routingCase.expectAgents?.length ?? 0) > 0;
  return {
    pass: (!needsExpected || expectedHit.length > 0) && forbiddenHit.length === 0,
    expectedHit,
    forbiddenHit,
  };
}

/**
 * Was the run usable? Hitting --max-turns is expected (routing happens in the
 * first turns) and so is a denial of a deliberately disallowed tool (Edit,
 * Write, Bash). A crash, an unparseable stream, budget exhaustion or a denial
 * of a routing tool is a harness error, excluded from the scores.
 */
export function classifyRoutingRun(run) {
  if (run.signal) return { status: 'error', reason: `claude killed by signal ${run.signal}` };
  let parsed;
  try {
    parsed = parseClaudeStream(run.stdout);
  } catch (error) {
    const stderr =
      String(run.stderr ?? '')
        .trim()
        .split('\n')[0]
        ?.slice(0, 160) ?? '';
    return {
      status: 'error',
      reason:
        `unparseable stream (exit ${run.status}): ${error.message.slice(0, 80)} ${stderr}`.trim(),
    };
  }
  if (parsed.subtype && /budget/i.test(parsed.subtype))
    return { status: 'error', reason: `budget exhausted (${parsed.subtype})`, parsed };
  const deniedRouting = parsed.permissionDenials
    .map((d) => d?.tool_name)
    .filter((tool) => ROUTING_TOOLS.has(tool));
  if (deniedRouting.length > 0)
    return {
      status: 'error',
      reason: `permission denied: ${[...new Set(deniedRouting)].join(', ')}`,
      parsed,
    };
  if (run.status !== 0 && parsed.subtype !== 'error_max_turns' && parsed.subtype !== 'success')
    return { status: 'error', reason: `claude exited ${run.status} (${parsed.subtype})`, parsed };
  return { status: 'ok', parsed };
}

export function buildRoutingClaudeArgs({ maxBudgetUsd = 1, model = null } = {}) {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--max-turns',
    '3',
    '--max-budget-usd',
    String(maxBudgetUsd),
    '--permission-mode',
    'dontAsk',
  ];
  if (model) args.push('--model', model);
  // Task is the documented name of the subagent tool; Agent is its newer alias.
  args.push('--allowedTools', 'Read', 'Grep', 'Glob', 'Skill', 'Task', 'Agent');
  args.push('--disallowedTools', 'Edit', 'Write', 'Bash', 'NotebookEdit');
  return args;
}

// ---------------------------------------------------------------- summary

const ratio = (a, b) => (b > 0 ? a / b : null);
const pct = (v) => (v === null || v === undefined ? 'n/a' : `${Math.round(v * 100)}%`);

/**
 * Per-case pass@1 / pass^n, per-name (skill:x / agent:y) precision and recall
 * over scored runs (truth: the name is in the case's expect list; prediction:
 * it ran), and totals with a Wilson 95% CI on the run pass rate.
 */
export function summariseRouting(cases, runs) {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const caseRows = cases.map((c) => {
    const mine = runs.filter((r) => r.caseId === c.id);
    const scored = mine.filter((r) => r.status === 'ok');
    const passes = scored.filter((r) => r.grade?.pass).length;
    const invoked = new Set();
    for (const r of scored) {
      for (const s of r.toolStats?.skills ?? []) invoked.add(`skill:${normaliseName(s)}`);
      for (const a of r.toolStats?.agents ?? []) invoked.add(`agent:${normaliseName(a)}`);
    }
    const n = scored.length;
    return {
      id: c.id,
      split: c.split,
      kind: c.kind,
      runs: mine.length,
      scored: n,
      passes,
      errors: mine.length - n,
      passAt1: ratio(passes, n),
      passAtN: n > 0 ? passAtK(n, passes, n) : null,
      passHatN: n > 0 ? passHatK(n, passes, n) : null,
      invoked: [...invoked].sort(),
      errorReasons: mine.filter((r) => r.status !== 'ok').map((r) => r.reason ?? 'error'),
    };
  });

  const names = new Set();
  for (const c of cases) {
    for (const s of c.expectSkills) names.add(`skill:${s}`);
    for (const a of c.expectAgents) names.add(`agent:${a}`);
  }
  for (const r of runs) {
    if (r.status !== 'ok') continue;
    for (const s of r.toolStats?.skills ?? []) names.add(`skill:${normaliseName(s)}`);
    for (const a of r.toolStats?.agents ?? []) names.add(`agent:${normaliseName(a)}`);
  }
  const nameRows = [...names].sort().map((name) => {
    const [kind, bare] = [name.slice(0, name.indexOf(':')), name.slice(name.indexOf(':') + 1)];
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const r of runs) {
      const c = byId.get(r.caseId);
      if (r.status !== 'ok' || !c) continue;
      const expected = (kind === 'skill' ? c.expectSkills : c.expectAgents).includes(bare);
      const invoked = (kind === 'skill' ? r.toolStats?.skills : r.toolStats?.agents) ?? [];
      const ran = invoked.map(normaliseName).includes(bare);
      if (expected && ran) tp += 1;
      else if (ran) fp += 1;
      else if (expected) fn += 1;
    }
    return { name, tp, fp, fn, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn) };
  });

  const scoredRuns = runs.filter((r) => r.status === 'ok');
  const passes = scoredRuns.filter((r) => r.grade?.pass).length;
  const kindTotals = (kind) => {
    const rows = caseRows.filter((row) => row.kind === kind && row.passAt1 !== null);
    return rows.length > 0 ? rows.reduce((a, row) => a + row.passAt1, 0) / rows.length : null;
  };
  const costs = runs.map((r) => r.costUsd).filter((v) => typeof v === 'number');
  return {
    cases: caseRows,
    names: nameRows,
    totals: {
      runs: runs.length,
      scored: scoredRuns.length,
      passes,
      errors: runs.length - scoredRuns.length,
      passRate: ratio(passes, scoredRuns.length),
      passRateCi: wilsonInterval(passes, scoredRuns.length),
      positivePassAt1: kindTotals('positive'),
      negativePassAt1: kindTotals('negative'),
      costUsd: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null,
    },
  };
}

export function formatRoutingMarkdown({ config, runsPerCase, summary, harnessSha, model }) {
  const n = runsPerCase;
  const t = summary.totals;
  const ci = t.passRateCi ? ` (95% CI ${pct(t.passRateCi.low)}-${pct(t.passRateCi.high)})` : '';
  const lines = [
    `# Routing eval: ${config}`,
    '',
    `Harness ${harnessSha ?? '?'}; model ${model ?? 'CLI default'}; ${n} run(s) per case.`,
    '',
    `Run pass rate ${pct(t.passRate)}${ci} over ${t.scored} scored runs; ${t.errors} error(s). ` +
      `Mean pass@1: positive ${pct(t.positivePassAt1)}, negative ${pct(t.negativePassAt1)}. ` +
      `Cost ${t.costUsd === null ? 'n/a' : `$${t.costUsd.toFixed(2)}`}.`,
    '',
    `| case | split | kind | passed / scored | pass@1 | pass^${n} | invoked | errors |`,
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const row of summary.cases) {
    const hat = row.scored === n ? pct(row.passHatN) : `${pct(row.passHatN)} (n=${row.scored})`;
    lines.push(
      `| ${row.id} | ${row.split} | ${row.kind} | ${row.passes} / ${row.scored} | ${pct(row.passAt1)} | ${hat} | ${row.invoked.join(', ') || '-'} | ${row.errors > 0 ? `${row.errors}: ${row.errorReasons.join('; ')}` : ''} |`
    );
  }
  lines.push(
    '',
    '| skill / agent | TP | FP | FN | precision | recall |',
    '|---|---|---|---|---|---|'
  );
  for (const row of summary.names)
    lines.push(
      `| ${row.name} | ${row.tp} | ${row.fp} | ${row.fn} | ${pct(row.precision)} | ${pct(row.recall)} |`
    );
  lines.push(
    '',
    "Precision/recall are per run: truth = the name is in the case's expect list, prediction = it ran."
  );
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------- execution

async function must(exec, command, args, what, opts) {
  const res = await exec.run(command, args, opts);
  if (res.status !== 0)
    throw new Error(`${what} failed: ${(res.stderr || res.stdout).trim().slice(0, 300)}`);
  return res.stdout.trim();
}

/** History-free snapshot of `ref`: git archive -> temp dir -> fresh one-commit repo. */
export async function createSnapshot(exec, ref, tmpRoot = os.tmpdir()) {
  const sha = await must(
    exec,
    'git',
    ['-C', ROOT, 'rev-parse', '--verify', `${ref}^{commit}`],
    'resolve --ref'
  );
  const parent = fs.mkdtempSync(path.join(tmpRoot, 'restura-routing-eval-'));
  const dir = path.join(parent, 'repo');
  fs.mkdirSync(dir);
  const tar = path.join(parent, 'snapshot.tar');
  await must(exec, 'git', ['-C', ROOT, 'archive', '--format=tar', '-o', tar, sha], 'git archive');
  await must(exec, 'tar', ['-xf', tar, '-C', dir], 'extract snapshot');
  fs.rmSync(tar, { force: true });
  const id = ['-c', 'user.name=routing-eval', '-c', 'user.email=routing-eval@invalid'];
  await must(exec, 'git', ['-C', dir, 'init', '-q'], 'git init');
  await must(exec, 'git', ['-C', dir, 'add', '-A'], 'git add');
  await must(
    exec,
    'git',
    ['-C', dir, ...id, 'commit', '-q', '--no-verify', '-m', 'snapshot'],
    'git commit'
  );
  return { sha, dir, parent };
}

function printPlan(cases, options) {
  const log = (line) => process.stdout.write(`${line}\n`);
  log(
    `Routing eval plan: ${cases.length} case(s) x ${options.runs} run(s), split ${options.split}`
  );
  log(`  harness ref ${options.ref}; up to $${options.maxBudgetUsd} per run`);
  log(`  claude ${buildRoutingClaudeArgs(options).join(' ')}`);
  for (const c of cases) {
    const want = [
      ...c.expectSkills.map((s) => `skill:${s}`),
      ...c.expectAgents.map((a) => `agent:${a}`),
    ];
    const deny = [
      ...c.forbidSkills.map((s) => `skill:${s}`),
      ...c.forbidAgents.map((a) => `agent:${a}`),
    ];
    log(
      `  - ${c.id} [${c.split}, ${c.kind}] expect ${want.join(' | ') || '-'}; forbid ${deny.join(', ') || '-'}`
    );
  }
}

export async function runRoutingEval(options, exec = nodeExec) {
  const cases = loadRoutingCases({ split: options.split, caseIds: options.caseIds });
  if (cases.length === 0) throw new Error('no routing cases selected');
  printPlan(cases, options);
  if (options.dryRun) {
    process.stdout.write('Dry run: cases valid; no model calls made.\n');
    return { failed: false };
  }

  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(options.out, 'routing');
  const base = path.join(outDir, `${stamp}--${options.config}`);
  const transcripts = `${base}-transcripts`;
  fs.mkdirSync(transcripts, { recursive: true });

  let snapshot;
  const cleanup = () => {
    if (snapshot) fs.rmSync(snapshot.parent, { recursive: true, force: true });
  };
  const onSignal = (signal) => {
    cleanup();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const runs = [];
  try {
    snapshot = await createSnapshot(exec, options.ref);
    for (const c of cases) {
      for (let k = 1; k <= options.runs; k += 1) {
        process.stdout.write(`${c.id} run ${k}/${options.runs}...\n`);
        const raw = await exec.run('claude', buildRoutingClaudeArgs(options), {
          cwd: snapshot.dir,
          input: c.prompt,
          timeout: RUN_TIMEOUT_MS,
        });
        const transcript = path.join(transcripts, `${c.id}-run${k}.jsonl`);
        fs.writeFileSync(transcript, raw.stdout ?? '');
        const verdict = classifyRoutingRun(raw);
        const toolStats = verdict.parsed?.toolStats ?? null;
        runs.push({
          caseId: c.id,
          run: k,
          status: verdict.status,
          reason: verdict.reason ?? null,
          toolStats,
          grade: verdict.status === 'ok' ? gradeRoutingRun(c, toolStats) : null,
          costUsd: verdict.parsed?.costUsd ?? null,
          durationMs: verdict.parsed?.durationMs ?? null,
          transcript: path.relative(outDir, transcript),
        });
      }
    }
  } finally {
    cleanup();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  const summary = summariseRouting(cases, runs);
  const result = {
    kind: 'routing-eval',
    config: options.config,
    harnessSha: snapshot?.sha ?? null,
    model: options.model,
    split: options.split,
    runsPerCase: options.runs,
    maxBudgetUsd: options.maxBudgetUsd,
    startedAt: startedAt.toISOString(),
    summary,
    runs,
  };
  fs.writeFileSync(`${base}.json`, `${JSON.stringify(result, null, 2)}\n`);
  const markdown = formatRoutingMarkdown(result);
  fs.writeFileSync(`${base}.md`, markdown);
  process.stdout.write(`\n${markdown}\nWrote ${base}.json and ${base}.md\n`);
  return { failed: runs.some((r) => r.status !== 'ok') };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const { failed } = await runRoutingEval(parseRoutingArgs(process.argv.slice(2)));
    process.exitCode = failed ? 1 : 0;
  } catch (error) {
    console.error(`routing-eval: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
