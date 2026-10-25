import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  baselinePath,
  buildBaseline,
  buildJudgePrompt,
  buildReviewPrompt,
  classifyClaudeRun,
  cleanupTracked,
  cleanupTrackedAsync,
  createIsolatedRepo,
  decideCaught,
  detectContamination,
  diffFlips,
  formatSummaryMarkdown,
  gradeMustMention,
  HARNESS_OVERLAY_PATHS,
  judgeModelWarning,
  linkNodeModules,
  loadCases,
  majorityVerdict,
  mergePackageScripts,
  nodeExec,
  overlayHarness,
  parseClaudeJson,
  parseClaudeStream,
  parseEvalArgs,
  parseJudgeVerdict,
  parseWorktreePorcelain,
  passAtK,
  passHatK,
  runCase,
  selectLeftovers,
  summarise,
  syncExec,
  validateCase,
  wilsonInterval,
  writeBaseline,
} from '../harness-eval.mjs';

const BASE = '90b514e380786e4935058871113315c73e5b2539';
const HARNESS = 'abcdef0123456789abcdef0123456789abcdef01';
const EFFECTIVE = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

function validRaw(overrides = {}) {
  return {
    id: 'mcp-panel-collapse',
    title: 'Two MCP toolbar buttons collapse the headers toggle',
    origin: 'real',
    sourcePRs: ['#1133', '#1134'],
    fixPRs: ['#1150'],
    base: BASE,
    seam: 'cross-branch',
    branches: [
      { name: 'feat/mcp-import', patches: ['a.patch'] },
      { name: 'feat/mcp-conformance', patches: ['b.patch'] },
    ],
    expected: {
      defect: 'The flex-1 min-w-0 toggle is squeezed to 2px by two shrink-0 buttons.',
      files: ['src/features/mcp/components/McpConnectionPanel.tsx'],
      symbols: ['McpConnectionPanel'],
    },
    mustMention: ['McpConnectionPanel', '(shrink-0|min-w-0|flex-1)'],
    mustNotMiss: 'high',
    split: 'train',
    ...overrides,
  };
}

function cleanRaw(overrides = {}) {
  return {
    id: 'clean-timeline-flush-cost',
    title: 'Timeline flush skips sanitising events the byte cap would evict',
    origin: 'real',
    expectClean: true,
    sourcePRs: ['#1157'],
    base: BASE,
    seam: 'none',
    branches: [{ name: 'perf/timeline-flush-cost', patches: ['01.patch'] }],
    expected: {
      summary: 'Skips sanitising queued events that the byte cap evicts anyway.',
      files: ['src/store/useStreamTimelineStore.ts'],
    },
    split: 'test',
    ...overrides,
  };
}

const allExist = () => true;
const env = { fileExists: allExist, fixturesDir: '/fx' };
const defectCase = () => validateCase(validRaw(), env).value;
const cleanCase = () => validateCase(cleanRaw(), env).value;

// ---------------------------------------------------------------- schema

test('validateCase accepts a well-formed defect case and marks its anchor patterns', () => {
  const result = validateCase(validRaw(), env);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(result.value.expectClean, false);
  assert.deepEqual(result.value.anchors, ['McpConnectionPanel']);
  assert.deepEqual(result.value.branches[0].patchPaths, ['/fx/mcp-panel-collapse/a.patch']);
});

test('validateCase reports every problem, not just the first', () => {
  const result = validateCase(
    validRaw({
      id: 'Bad Id',
      origin: 'made-up',
      base: 'main',
      branches: [],
      mustMention: ['(unclosed'],
      mustNotMiss: 'urgent',
      expected: { files: [] },
    }),
    env
  );
  assert.equal(result.ok, false);
  const text = result.errors.join('\n');
  for (const field of [
    /id/,
    /origin/,
    /base/,
    /branches/,
    /mustMention\[0\]/,
    /mustNotMiss/,
    /expected\.defect/,
    /expected\.files/,
  ])
    assert.match(text, field);
});

test('validateCase requires real cases to cite source PRs and patch files to exist', () => {
  const result = validateCase(validRaw({ sourcePRs: [] }), {
    fileExists: (p) => !p.endsWith('b.patch'),
    fixturesDir: '/fx',
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /sourcePRs/);
  assert.match(result.errors.join('\n'), /b\.patch/);
  assert.equal(validateCase(validRaw({ origin: 'synthetic', sourcePRs: [] }), env).ok, true);
});

test('validateCase rejects duplicate branch names and path-escaping patches', () => {
  const result = validateCase(
    validRaw({
      branches: [
        { name: 'dup', patches: ['a.patch'] },
        { name: 'dup', patches: ['../../etc/passwd'] },
      ],
    }),
    env
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /duplicate branch/);
  assert.match(result.errors.join('\n'), /inside the case fixture dir/);
});

test('validateCase requires a defect case to have a file-or-symbol mustMention pattern', () => {
  const noAnchor = validateCase(validRaw({ mustMention: ['(shrink-0|flex-1)'] }), env);
  assert.equal(noAnchor.ok, false);
  assert.match(noAnchor.errors.join('\n'), /file or symbol/);
  // `web` matches nothing in files/symbols; `(\bGET\b|web)` would also be too loose.
  const loose = validateCase(
    validRaw({
      expected: { ...validRaw().expected, symbols: ['McpConnectionPanel', 'web'] },
      mustMention: ['(\\bGET\\b|web)'],
    }),
    env
  );
  assert.equal(loose.ok, false);
  assert.match(loose.errors.join('\n'), /too loose/);
});

test('validateCase accepts a clean control and rejects defect-only fields on it', () => {
  const ok = validateCase(cleanRaw(), env);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.expectClean, true);
  assert.deepEqual(ok.value.mustMention, []);
  const bad = validateCase(
    cleanRaw({ seam: 'cross-branch', mustMention: ['x'], expected: { files: ['a.ts'] } }),
    env
  );
  assert.equal(bad.ok, false);
  const text = bad.errors.join('\n');
  assert.match(text, /seam must be none/);
  assert.match(text, /mustMention/);
  assert.match(text, /expected\.summary/);
});

// ---------------------------------------------------------------- grading

test('gradeMustMention is case-insensitive, lists misses and reports anchor hits', () => {
  const graded = gradeMustMention(
    'The mcpConnectionPanel row has two SHRINK-0 buttons',
    ['McpConnectionPanel', 'shrink-0', 'flex-wrap'],
    ['McpConnectionPanel']
  );
  assert.deepEqual(graded.passed, ['McpConnectionPanel', 'shrink-0']);
  assert.deepEqual(graded.missed, ['flex-wrap']);
  assert.equal(graded.allPassed, false);
  assert.equal(graded.anchorMatched, true);
  assert.equal(
    gradeMustMention('shrink-0', ['McpConnectionPanel'], ['McpConnectionPanel']).anchorMatched,
    false
  );
});

test('decideCaught needs judge AND an anchor for defects; controls follow the judge', () => {
  const evalCase = defectCase();
  const anchor = { anchorMatched: true, allPassed: true };
  const noAnchor = { anchorMatched: false, allPassed: false };
  assert.equal(decideCaught(evalCase, { caught: true }, anchor), true);
  assert.equal(decideCaught(evalCase, { caught: true }, noAnchor), false);
  assert.equal(decideCaught(evalCase, { caught: false }, anchor), false);
  assert.equal(decideCaught(evalCase, null, anchor), true);
  assert.equal(decideCaught(cleanCase(), { caught: true }, null), true);
  assert.equal(decideCaught(cleanCase(), { caught: false }, null), false);
});

test('parseClaudeJson extracts text, cost, duration and denials', () => {
  const parsed = parseClaudeJson(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'NOT READY',
      total_cost_usd: 1.25,
      duration_ms: 4200,
      num_turns: 7,
      is_error: false,
      session_id: 's1',
      permission_denials: [],
    })
  );
  assert.deepEqual(parsed, {
    text: 'NOT READY',
    subtype: 'success',
    costUsd: 1.25,
    durationMs: 4200,
    numTurns: 7,
    isError: false,
    sessionId: 's1',
    permissionDenials: [],
  });
  assert.throws(() => parseClaudeJson('not json'), /claude JSON/);
});

const ok = (extra = {}) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'fine', ...extra });

test('classifyClaudeRun separates harness errors from real answers', () => {
  assert.equal(classifyClaudeRun({ status: 0, stdout: ok(), stderr: '' }).status, 'ok');
  const cases = [
    [
      { status: 0, stdout: ok({ permission_denials: [{ tool_name: 'Bash', tool_input: {} }] }) },
      /permission denied: Bash/,
    ],
    [{ status: 0, stdout: ok({ subtype: 'error_max_budget_usd', is_error: true }) }, /budget/],
    [{ status: 0, stdout: ok({ subtype: 'error_max_turns', is_error: true }) }, /error_max_turns/],
    [{ status: 0, stdout: ok({ is_error: true }) }, /is_error/],
    [{ status: 2, stdout: ok(), stderr: 'crash' }, /exited 2/],
    [{ status: 0, stdout: '{oops', stderr: '' }, /unparseable/],
    [{ status: 0, stdout: ok(), stderr: 'Tool Bash is not allowed' }, /not allowed/],
    [{ status: 0, stdout: ok(), stderr: 'Exceeded USD budget (20)' }, /budget/],
    [{ status: null, signal: 'SIGINT', stdout: '' }, /signal SIGINT/],
  ];
  for (const [run, reason] of cases) {
    const classified = classifyClaudeRun({ stderr: '', ...run });
    assert.equal(classified.status, 'error', JSON.stringify(run));
    assert.match(classified.reason, reason);
  }
  // A review that merely talks about permissions is still a real answer.
  assert.equal(
    classifyClaudeRun({
      status: 0,
      stdout: ok({ result: 'Finding: the IPC handler lacks a permission check' }),
      stderr: '',
    }).status,
    'ok'
  );
});

test('parseJudgeVerdict accepts fenced or prose-wrapped JSON and clamps the score', () => {
  assert.deepEqual(
    parseJudgeVerdict('Here:\n```json\n{"caught": true, "score": 3, "reason": "named it"}\n```'),
    { caught: true, score: 3, reason: 'named it' }
  );
  assert.deepEqual(parseJudgeVerdict('{"caught": false, "score": 9, "reason": "x"}'), {
    caught: false,
    score: 3,
    reason: 'x',
  });
  assert.throws(() => parseJudgeVerdict('no verdict'), /judge verdict/);
  assert.throws(() => parseJudgeVerdict('{"score": 1}'), /caught/);
});

// ---------------------------------------------------------------- prompts

test('buildReviewPrompt uses ship-check --quick, names branches and the EFFECTIVE base, never leaks the defect', () => {
  const prompt = buildReviewPrompt(
    defectCase(),
    ['harness-eval/r1/feat/mcp-import', 'harness-eval/r1/feat/mcp-conformance'],
    EFFECTIVE
  );
  assert.match(
    prompt,
    /^\/ship-check --quick harness-eval\/r1\/feat\/mcp-import harness-eval\/r1\/feat\/mcp-conformance\n/
  );
  assert.match(prompt, new RegExp(EFFECTIVE));
  assert.match(prompt, new RegExp(`--base ${EFFECTIVE}`));
  // The case's raw base predates the overlay commit; diffing against it would show the overlay.
  assert.doesNotMatch(prompt, new RegExp(BASE));
  assert.doesNotMatch(prompt, /shrink-0|squeezed|McpConnectionPanel/);
  assert.doesNotMatch(buildReviewPrompt(cleanCase(), ['b'], EFFECTIVE), /clean|control|byte cap/i);
  assert.throws(() => buildReviewPrompt(defectCase(), ['b']), /effective base/);
});

test('buildJudgePrompt embeds the rubric and the defect, or the control instructions', () => {
  const prompt = buildJudgePrompt({ rubric: 'RUBRIC', evalCase: defectCase(), reviewText: 'REV' });
  assert.match(prompt, /RUBRIC/);
  assert.match(prompt, /squeezed to 2px/);
  assert.match(prompt, /REV/);
  assert.match(prompt, /McpConnectionPanel\.tsx/);
  const control = buildJudgePrompt({ rubric: 'RUBRIC', evalCase: cleanCase(), reviewText: 'REV' });
  assert.match(control, /CONTROL/);
  assert.match(control, /useStreamTimelineStore\.ts/);
  assert.doesNotMatch(control, /Expected defect/);
});

// ---------------------------------------------------------------- reporting

test('summarise excludes harness errors and splits defect recall from control precision', () => {
  const summary = summarise([
    {
      caseId: 'a',
      status: 'ok',
      expectClean: false,
      caught: true,
      judge: { score: 3 },
      review: { costUsd: 2, durationMs: 120000 },
      judgeCostUsd: 0.5,
    },
    {
      caseId: 'a',
      status: 'ok',
      expectClean: false,
      caught: false,
      judge: { score: 1 },
      review: { costUsd: 1, durationMs: 60000 },
      judgeCostUsd: 0.5,
    },
    { caseId: 'a', status: 'error', expectClean: false, caught: null, reason: 'denied' },
    { caseId: 'c', status: 'ok', expectClean: true, caught: true, judge: { score: 3 } },
    { caseId: 'c', status: 'ok', expectClean: true, caught: false, judge: { score: 0 } },
  ]);
  assert.deepEqual(summary.cases.a, {
    expectClean: false,
    runs: 2,
    caught: 1,
    errors: 1,
    flipped: true,
    meanScore: 2,
    passAt1: 0.5,
    passAtK: 1,
    passHatK: 0,
    judgeDisagreements: 0,
    meanCostUsd: 2,
    meanMinutes: 1.5,
  });
  assert.deepEqual(summary.cases.c, {
    expectClean: true,
    runs: 2,
    caught: 1,
    errors: 0,
    flipped: true,
    meanScore: 1.5,
    passAt1: 0.5,
    passAtK: 1,
    passHatK: 0,
    judgeDisagreements: 0,
    meanCostUsd: null,
    meanMinutes: null,
  });
  assert.equal(summary.recall.caught, 1);
  assert.equal(summary.recall.runs, 2);
  assert.equal(summary.recall.rate, 0.5);
  assert.ok(summary.recall.ci.low < 0.5 && summary.recall.ci.high > 0.5);
  assert.equal(summary.controls.clean, 1);
  assert.equal(summary.controls.falsePositives, 1);
  assert.equal(summary.controls.runs, 2);
  assert.ok(summary.controls.ci.halfWidth > 0);
  assert.equal(summary.errors, 1);
  assert.deepEqual(summary.totals, { costUsd: 4, minutes: 3, runs: 5 });
  assert.equal(summary.noise.flippedCases, 2);
  // Totals: mean per-case pass@1, separately for defects and controls.
  assert.deepEqual(summary.passAt1, { defects: 0.5, controls: 0.5 });
  assert.equal(summary.noise.recallHalfWidth, summary.recall.ci.halfWidth);
});

test('diffFlips ignores errored runs and labels defect vs control flips', () => {
  const previous = {
    runs: [
      { caseId: 'a', status: 'ok', expectClean: false, caught: true },
      { caseId: 'a', status: 'ok', expectClean: false, caught: true },
      { caseId: 'b', status: 'ok', expectClean: false, caught: false },
      { caseId: 'c', status: 'ok', expectClean: true, caught: true },
    ],
  };
  const current = {
    runs: [
      { caseId: 'a', status: 'ok', expectClean: false, caught: false },
      { caseId: 'a', status: 'error', expectClean: false, caught: null },
      { caseId: 'b', status: 'ok', expectClean: false, caught: false },
      { caseId: 'b', status: 'ok', expectClean: false, caught: true },
      { caseId: 'c', status: 'ok', expectClean: true, caught: false },
      { caseId: 'd', status: 'ok', expectClean: false, caught: true },
    ],
  };
  assert.deepEqual(diffFlips(previous, current), [
    { caseId: 'a', type: 'defect', before: '2/2', after: '0/1', kind: 'regressed' },
    { caseId: 'b', type: 'defect', before: '0/1', after: '1/2', kind: 'improved' },
    { caseId: 'c', type: 'control', before: '1/1', after: '0/1', kind: 'regressed' },
  ]);
});

test('formatSummaryMarkdown reports recall, control precision, errors and flips', () => {
  const md = formatSummaryMarkdown(
    {
      config: 'current',
      startedAt: '2026-10-25T00:00:00.000Z',
      dryRun: false,
      runs: [
        {
          caseId: 'a',
          run: 1,
          status: 'ok',
          expectClean: false,
          caught: true,
          judgeCaught: true,
          patternCaught: true,
          deterministic: { allPassed: true, passed: ['x'], missed: [], anchorMatched: true },
          judge: { caught: true, score: 3, reason: 'ok' },
          review: { costUsd: 1.5, durationMs: 60000 },
        },
        {
          caseId: 'a',
          run: 2,
          status: 'ok',
          expectClean: false,
          caught: false,
          judgeCaught: true,
          patternCaught: false,
          deterministic: { allPassed: false, passed: [], missed: ['x'], anchorMatched: false },
          judge: { caught: true, score: 2, reason: 'vague' },
          review: { costUsd: 1, durationMs: 60000 },
        },
        {
          caseId: 'c',
          run: 1,
          status: 'ok',
          expectClean: true,
          caught: false,
          judgeCaught: false,
          judge: { caught: false, score: 0, reason: 'flagged a high issue' },
          review: { costUsd: 1, durationMs: 1000 },
        },
        {
          caseId: 'c',
          run: 2,
          status: 'error',
          expectClean: true,
          caught: null,
          reason: 'permission denied: Bash',
        },
      ],
    },
    [{ caseId: 'a', type: 'defect', before: '0/1', after: '1/2', kind: 'improved' }]
  );
  assert.match(md, /Recall on defect cases: 1\/2/);
  assert.match(md, /Controls: 0\/1 clean, 1 false positive/);
  assert.match(md, /\| a \| defect \| 1\/2 \|/);
  assert.match(md, /judge-only/i);
  assert.match(md, /Harness errors/);
  assert.match(md, /permission denied: Bash/);
  assert.match(md, /improved/);
});

test('parseEvalArgs applies defaults, flags and validation', () => {
  const defaults = parseEvalArgs([]);
  assert.equal(defaults.harnessRef, 'HEAD');
  assert.equal(defaults.judgeModel, 'sonnet');
  assert.equal(defaults.model, undefined);
  assert.equal(defaults.judgeRepeat, 1);
  assert.equal(defaults.split, 'all');
  assert.equal(defaults.saveBaseline, false);
  assert.equal(defaults.runs, 2);
  assert.equal(defaults.config, 'current');
  assert.equal(defaults.dryRun, false);
  assert.equal(defaults.cleanup, false);
  assert.equal(defaults.judge, true);
  assert.equal(defaults.out, '.claude/metrics/evals');
  assert.deepEqual(defaults.caseIds, []);
  const parsed = parseEvalArgs([
    '--case',
    'a',
    '--case=b',
    '--runs',
    '3',
    '--config',
    'skills',
    '--dry-run',
    '--out',
    '/tmp/o',
    '--no-judge',
  ]);
  assert.deepEqual(parsed.caseIds, ['a', 'b']);
  assert.equal(parsed.runs, 3);
  assert.equal(parsed.config, 'skills');
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.out, '/tmp/o');
  assert.equal(parsed.judge, false);
  assert.equal(parseEvalArgs(['--cleanup']).cleanup, true);
  assert.throws(() => parseEvalArgs(['--runs', '0']), /--runs/);
  assert.throws(() => parseEvalArgs(['--config', 'has space']), /--config/);
  assert.throws(() => parseEvalArgs(['--bogus']), /Unknown option/);
  const extra = parseEvalArgs([
    '--harness-ref',
    'feat/x',
    '--model',
    'opus',
    '--judge-model=haiku',
    '--judge-repeat',
    '3',
    '--split',
    'train',
    '--save-baseline',
  ]);
  assert.equal(extra.harnessRef, 'feat/x');
  assert.equal(extra.model, 'opus');
  assert.equal(extra.judgeModel, 'haiku');
  assert.equal(extra.judgeRepeat, 3);
  assert.equal(extra.split, 'train');
  assert.equal(extra.saveBaseline, true);
  assert.throws(() => parseEvalArgs(['--judge-repeat', '4']), /--judge-repeat/);
  assert.throws(() => parseEvalArgs(['--judge-repeat', '0']), /--judge-repeat/);
  assert.throws(() => parseEvalArgs(['--split', 'dev']), /--split/);
  assert.throws(() => parseEvalArgs(['--harness-ref', '-x']), /--harness-ref/);
});

test('judgeModelWarning fires only when the judge is the model under test', () => {
  assert.match(judgeModelWarning({ model: 'sonnet', judgeModel: 'sonnet' }), /judge/i);
  assert.equal(judgeModelWarning({ model: 'opus', judgeModel: 'sonnet' }), null);
  assert.equal(judgeModelWarning({ model: undefined, judgeModel: 'sonnet' }), null);
});

// ---------------------------------------------------------------- leftovers

test('parseWorktreePorcelain reads path, branch and detached entries', () => {
  const parsed = parseWorktreePorcelain(
    [
      'worktree /repo',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      'worktree /tmp/restura-harness-eval-x-AbC123/worktree',
      'HEAD def',
      'detached',
      '',
    ].join('\n')
  );
  assert.deepEqual(parsed, [
    { path: '/repo', branch: 'main' },
    { path: '/tmp/restura-harness-eval-x-AbC123/worktree', branch: null },
  ]);
});

test('selectLeftovers matches only the harness-eval/ prefix and this tool’s temp worktrees', () => {
  const selected = selectLeftovers({
    branches: [
      'main',
      'harness-eval/2026-10-25t00-1/feat/x',
      'harness-evaluation/keep',
      'feature/harness-eval/keep',
      'harness-eval',
      'chore/harness-evals',
    ],
    worktrees: [
      { path: '/repo', branch: 'main' },
      { path: '/var/tmp/restura-harness-eval-case-a-Zx9/worktree', branch: null },
      { path: '/somewhere/else', branch: 'harness-eval/r/feat/y' },
      { path: '/tmp/restura-integration-2026/worktree', branch: null },
      { path: '/tmp/restura-harness-eval-case-a-Zx9/worktree-not', branch: null },
      { path: '/repo/.claude/worktrees/agent-1', branch: 'chore/harness-evals' },
    ],
  });
  assert.deepEqual(selected.branches, ['harness-eval/2026-10-25t00-1/feat/x']);
  assert.deepEqual(selected.worktrees, [
    '/var/tmp/restura-harness-eval-case-a-Zx9/worktree',
    '/somewhere/else',
  ]);
});

// ---------------------------------------------------------------- runCase

const BASE_PKG = `${JSON.stringify(
  { name: 'restura', scripts: { dev: 'vite', 'worktree:setup': 'node old.mjs' } },
  null,
  2
)}\n`;
const HARNESS_PKG = `${JSON.stringify(
  {
    name: 'restura',
    scripts: {
      dev: 'vite --changed',
      'worktree:setup': 'node scripts/worktree-setup.mjs',
      'integration-check': 'node scripts/integration-check.mjs',
      'verify:agent-report': 'node scripts/verify-agent-report.mjs',
      'worktree:prune': 'node scripts/worktree-prune.mjs',
      'eval:harness': 'node scripts/harness-eval.mjs',
    },
  },
  null,
  2
)}\n`;

/** Default git answers so the harness overlay can run against a fake repo. */
function defaultGit(args) {
  if (args.includes('rev-parse') && args.at(-1) === 'HEAD')
    return { status: 0, stdout: `${EFFECTIVE}\n`, stderr: '' };
  if (args.includes('show') && args.at(-1) === `${HARNESS}:package.json`)
    return { status: 0, stdout: HARNESS_PKG, stderr: '' };
  if (args.includes('show') && args.at(-1) === 'HEAD:package.json')
    return { status: 0, stdout: BASE_PKG, stderr: '' };
  if (args.includes('hash-object')) return { status: 0, stdout: 'f'.repeat(40), stderr: '' };
  return undefined;
}

/** Records every command; `respond` may override a result. */
function fakeExec(respond = () => undefined) {
  const calls = [];
  return {
    calls,
    run(command, args, opts = {}) {
      calls.push({ command, args, opts, input: opts.input, line: [command, ...args].join(' ') });
      const custom = respond(command, args, calls);
      if (custom) return custom;
      if (command === 'git') return defaultGit(args) ?? { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '{}', stderr: '' };
    },
    pipe(from, to, opts = {}) {
      const line = `${[from[0], ...from[1]].join(' ')} | ${[to[0], ...to[1]].join(' ')}`;
      calls.push({ command: 'pipe', from, to, opts, line });
      return respond('pipe', [from, to], calls) ?? { status: 0, stdout: '', stderr: '' };
    },
  };
}
const lines = (exec) => exec.calls.map((c) => c.line).join('\n');

test('runCase dry-run applies patches, checks the combined merge and always cleans up', async () => {
  const exec = fakeExec();
  const tracker = { worktree: null, branches: [] };
  const result = await runCase(defectCase(), {
    exec,
    repo: '/repo',
    tempDir: '/tmp/he',
    runId: 'r1',
    dryRun: true,
    harnessSha: HARNESS,
    tracker,
  });
  assert.equal(result.applied, true);
  assert.equal(result.combinedMerge, 'clean');
  assert.equal(result.harnessSha, HARNESS);
  assert.equal(result.effectiveBase, EFFECTIVE);
  const joined = lines(exec);
  // A history-free repo in the run's temp dir: never a worktree of this repo.
  assert.doesNotMatch(joined, /worktree add/);
  assert.match(joined, /git init -q --initial-branch=main \/tmp\/he\/repo/);
  assert.ok(joined.includes(`git -C /repo archive ${BASE} | tar -x -f - -C /tmp/he/repo`));
  // Dry-run applies the overlay too, so it proves the patches still apply on top of it.
  assert.match(joined, /commit -q --no-verify --allow-empty -m harness overlay @ abcdef012345/);
  // Branches and the combined merge start from the overlay commit, never the raw base.
  assert.match(joined, new RegExp(`checkout -q --detach ${EFFECTIVE}`));
  assert.doesNotMatch(joined, new RegExp(`checkout -q --detach ${BASE}`));
  const overlayAt = exec.calls.findIndex((c) => c.line.includes('harness overlay @'));
  const firstBranch = exec.calls.findIndex((c) => c.line.includes('checkout -q -b'));
  assert.ok(overlayAt !== -1 && overlayAt < firstBranch, 'overlay is committed before branches');
  assert.match(joined, /-C \/tmp\/he\/repo apply --index \/fx\/mcp-panel-collapse\/a\.patch/);
  // Branches live only in the isolated repo, under their plain names.
  assert.match(joined, /-C \/tmp\/he\/repo checkout -q -b feat\/mcp-import/);
  assert.deepEqual(result.branches, ['feat/mcp-import', 'feat/mcp-conformance']);
  assert.doesNotMatch(joined, /harness-eval\//);
  assert.doesNotMatch(joined, /^claude/m);
  assert.deepEqual(tracker, { worktree: null, branches: [] });
  assertMainRepoReadOnly(exec);
});

/** The main repo is only read (archive / cat-file / show / rev-parse), never mutated. */
function assertMainRepoReadOnly(exec) {
  for (const call of exec.calls) {
    const args = call.command === 'pipe' ? call.from[1] : call.args;
    if (!args || args[0] !== '-C' || args[1] !== '/repo') continue;
    assert.ok(['archive', 'cat-file', 'show', 'rev-parse'].includes(args[2]), call.line);
  }
}

test('runCase reports a patch that fails to apply without touching the main repo', async () => {
  const exec = fakeExec((command, args) =>
    command === 'git' && args.includes('apply') && args.at(-1).endsWith('b.patch')
      ? { status: 1, stdout: '', stderr: 'boom' }
      : undefined
  );
  const result = await runCase(defectCase(), {
    exec,
    repo: '/repo',
    tempDir: '/tmp/he',
    runId: 'r1',
    dryRun: true,
    harnessSha: HARNESS,
  });
  assert.equal(result.applied, false);
  assert.equal(result.status, 'error');
  assert.match(result.reason, /b\.patch/);
  assertMainRepoReadOnly(exec);
});

/** A `--output-format stream-json --verbose` review: init, one Skill call, then the result. */
const reviewJson = (text, extra = {}) => ({
  status: 0,
  stdout: [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', tools: ['Bash'] }),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'ship-check' } }],
      },
    }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: text,
      total_cost_usd: 2,
      duration_ms: 1000,
      ...extra,
    }),
  ].join('\n'),
  stderr: '',
});
const judgeJson = (verdict) => ({
  status: 0,
  stdout: JSON.stringify({ result: verdict }),
  stderr: '',
});

function reviewExec(review, judge) {
  return fakeExec((command, _args, calls) => {
    if (command !== 'claude') return undefined;
    return calls.filter((c) => c.command === 'claude').length === 1 ? review : judge;
  });
}

const reviewCtx = (exec, extra = {}) => ({
  exec,
  repo: '/repo',
  tempDir: '/tmp/he',
  runId: 'r1',
  dryRun: false,
  judge: true,
  rubric: 'RUBRIC',
  harnessSha: HARNESS,
  setup: () => {},
  ...extra,
});

test('runCase review mode: caught needs judge AND an anchor pattern, and records both', async () => {
  const exec = reviewExec(
    reviewJson('McpConnectionPanel: shrink-0 buttons squeeze the toggle'),
    judgeJson('{"caught": true, "score": 3, "reason": "named"}')
  );
  const result = await runCase(defectCase(), reviewCtx(exec));
  const claudeCalls = exec.calls.filter((c) => c.command === 'claude');
  assert.equal(claudeCalls.length, 2);
  assert.match(claudeCalls[0].input, /^\/ship-check --quick /);
  assert.match(claudeCalls[0].input, new RegExp(EFFECTIVE));
  assert.doesNotMatch(claudeCalls[0].input, new RegExp(BASE));
  assert.ok(claudeCalls[0].args.includes('--max-budget-usd'));
  assert.match(claudeCalls[0].args.join(' '), /--output-format stream-json --verbose/);
  assert.match(claudeCalls[1].args.join(' '), /--output-format json/);
  assert.match(claudeCalls[1].args.join(' '), /--model sonnet/);
  assert.doesNotMatch(claudeCalls[0].args.join(' '), /--model/);
  assert.match(claudeCalls[1].input, /RUBRIC/);
  assert.equal(result.status, 'ok');
  assert.equal(result.review.costUsd, 2);
  assert.deepEqual(result.review.toolStats, { toolCalls: 1, skills: ['ship-check'], agents: [] });
  assert.equal(result.harnessSha, HARNESS);
  assert.equal(result.effectiveBase, EFFECTIVE);
  assert.equal(result.judgeCaught, true);
  assert.equal(result.patternCaught, true);
  assert.equal(result.caught, true);
  assertMainRepoReadOnly(exec);

  const vague = await runCase(
    defectCase(),
    reviewCtx(
      reviewExec(
        reviewJson('shrink-0 layout issue somewhere'),
        judgeJson('{"caught": true, "score": 2}')
      )
    )
  );
  assert.equal(vague.judgeCaught, true);
  assert.equal(vague.patternCaught, false);
  assert.equal(vague.caught, false);
});

test('runCase marks permission denials and judge failures as harness errors, not misses', async () => {
  const denied = await runCase(
    defectCase(),
    reviewCtx(
      reviewExec(
        reviewJson('partial', { permission_denials: [{ tool_name: 'Bash' }] }),
        judgeJson('{"caught": true, "score": 3}')
      )
    )
  );
  assert.equal(denied.status, 'error');
  assert.match(denied.reason, /permission denied/);
  assert.equal(denied.caught, null);

  const badJudge = await runCase(
    defectCase(),
    reviewCtx(
      reviewExec(reviewJson('McpConnectionPanel shrink-0'), {
        status: 0,
        stdout: 'garbage',
        stderr: '',
      })
    )
  );
  assert.equal(badJudge.status, 'error');
  assert.match(badJudge.reason, /judge/);
  assert.equal(badJudge.caught, null);
});

test('runCase grades a clean control by the judge alone', async () => {
  const result = await runCase(
    cleanCase(),
    reviewCtx(
      reviewExec(reviewJson('READY, no findings'), judgeJson('{"caught": true, "score": 3}'))
    )
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.expectClean, true);
  assert.equal(result.caught, true);
  const noJudge = await runCase(
    cleanCase(),
    reviewCtx(reviewExec(reviewJson('READY'), judgeJson('{}')), { judge: false })
  );
  assert.equal(noJudge.status, 'error');
  assert.match(noJudge.reason, /judge/);
});

test('cleanupTracked removes exactly the tracked worktree and branches', () => {
  const exec = fakeExec();
  cleanupTracked(exec, '/repo', {
    worktree: '/tmp/he/worktree',
    branches: ['harness-eval/r1/a', 'harness-eval/r1/b'],
  });
  assert.deepEqual(
    exec.calls.map((c) => c.line),
    [
      'git -C /repo worktree remove --force /tmp/he/worktree',
      'git -C /repo branch -D harness-eval/r1/a',
      'git -C /repo branch -D harness-eval/r1/b',
      'git -C /repo worktree prune',
    ]
  );
});

// ---------------------------------------------------------------- review round 2

test('formatSummaryMarkdown escapes backslashes before pipes so a `\\|` cannot break the table', () => {
  const md = formatSummaryMarkdown(
    {
      config: 'current',
      startedAt: '2026-10-25T00:00:00.000Z',
      dryRun: true,
      runs: [{ caseId: 'a', applied: false, combinedMerge: 'n/a', reason: 'bad \\| cell\nnext' }],
    },
    undefined
  );
  const row = md.split('\n').find((line) => line.startsWith('| a |'));
  assert.ok(row);
  assert.equal(row, '| a | NO | n/a | bad \\\\\\| cell next |');
  // Every unescaped pipe is a column separator: still exactly 5 of them.
  assert.equal(row.match(/(?<!\\)(?:\\\\)*\|/g).length, 5);
});

test('cleanupTrackedAsync runs remove, then each branch -D, then prune, strictly in order', async () => {
  const order = [];
  let inFlight = 0;
  const exec = {
    async run(command, args) {
      inFlight += 1;
      assert.equal(inFlight, 1, 'cleanup commands must not overlap');
      await new Promise((resolve) => setTimeout(resolve, 1));
      order.push([command, ...args].join(' '));
      inFlight -= 1;
      return { status: 0, stdout: '', stderr: '' };
    },
  };
  const tracker = {
    worktree: '/tmp/he/worktree',
    branches: ['harness-eval/r1/a', 'harness-eval/r1/b'],
  };
  const result = await cleanupTrackedAsync(exec, '/repo', tracker);
  assert.deepEqual(order, [
    'git -C /repo worktree remove --force /tmp/he/worktree',
    'git -C /repo branch -D harness-eval/r1/a',
    'git -C /repo branch -D harness-eval/r1/b',
    'git -C /repo worktree prune',
  ]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(tracker, { worktree: null, branches: [] });
});

test('cleanup keeps refs (and a worktree) that failed to delete in the tracker and reports them', async () => {
  const exec = fakeExec((command, args) =>
    command === 'git' && args.includes('-D') && args.at(-1) === 'harness-eval/r1/b'
      ? { status: 1, stdout: '', stderr: 'error: cannot lock ref' }
      : undefined
  );
  const tracker = {
    worktree: '/tmp/he/worktree',
    branches: ['harness-eval/r1/a', 'harness-eval/r1/b'],
  };
  const result = await cleanupTrackedAsync(exec, '/repo', tracker);
  assert.deepEqual(tracker, { worktree: null, branches: ['harness-eval/r1/b'] });
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0], /harness-eval\/r1\/b: error: cannot lock ref/);

  const stuck = fakeExec((command, args) =>
    command === 'git' && args.includes('remove')
      ? { status: 128, stdout: '', stderr: 'busy' }
      : undefined
  );
  const tracker2 = { worktree: '/tmp/he/worktree', branches: [] };
  const sync = cleanupTracked(stuck, '/repo', tracker2);
  assert.equal(tracker2.worktree, '/tmp/he/worktree');
  assert.match(sync.failed[0], /worktree \/tmp\/he\/worktree: busy/);
});

test('runCase fails closed when the isolated repo cannot be built', async () => {
  const exec = fakeExec((command) =>
    command === 'pipe' ? { status: 2, stdout: '', stderr: 'tar: broken' } : undefined
  );
  const result = await runCase(defectCase(), {
    exec,
    repo: '/repo',
    tempDir: '/tmp/he',
    runId: 'r1',
    dryRun: true,
    harnessSha: HARNESS,
  });
  assert.equal(result.applied, false);
  assert.equal(result.status, 'error');
  assert.match(result.reason, /tar: broken/);
});

test('validateCase accepts an optional full sourceCommit SHA and rejects anything else', () => {
  const sha = 'f26b7ae6bbf0421da87ac5702e7e577aabb26270';
  assert.equal(validateCase(cleanRaw({ sourceCommit: sha }), env).value.sourceCommit, sha);
  const bad = validateCase(cleanRaw({ sourceCommit: 'f26b7ae6' }), env);
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join('\n'), /sourceCommit/);
});

test('mustMention patterns honour inline case-sensitivity modifiers', () => {
  assert.equal(gradeMustMention('we get the body', ['(?-i:\\bGET\\b)'], []).allPassed, false);
  assert.equal(gradeMustMention('a GET request', ['(?-i:\\bGET\\b)'], []).allPassed, true);
});

test('no real case pattern fires on bare-word distractors (nonce, double-check, design, get)', () => {
  const distractor =
    'Please double-check the nonce once more, then get started on the design; the bandwidth, ' +
    'signal handling and stackoverflow-free recursion look fine overall, again.';
  for (const evalCase of loadCases()) {
    for (const pattern of evalCase.mustMention) {
      assert.doesNotMatch(distractor, new RegExp(pattern, 'i'), `${evalCase.id}: ${pattern}`);
    }
  }
});

// ---------------------------------------------------------------- harness overlay

test('overlayHarness replaces the base harness with the one at harnessSha and commits it', async () => {
  const exec = fakeExec((command, args) =>
    command === 'git' && args.includes('cat-file') && args.at(-1) === `${HARNESS}:skills-lock.json`
      ? { status: 128, stdout: '', stderr: 'missing' }
      : undefined
  );
  const result = await overlayHarness(exec, '/tmp/he/worktree', HARNESS);
  assert.deepEqual(result, { harnessSha: HARNESS, effectiveBase: EFFECTIVE });
  const git = exec.calls.filter((c) => c.command === 'git');
  for (const call of git) assert.deepEqual(call.args.slice(0, 2), ['-C', '/tmp/he/worktree']);

  const rm = git.find((c) => c.args.includes('rm'));
  assert.ok(rm, 'removes the base harness');
  for (const p of [
    '.claude/skills',
    '.claude/agents',
    '.claude/commands',
    '.claude/hooks',
    '.claude/settings.json',
    '.agents/skills',
  ])
    assert.ok(rm.args.includes(p), `rm ${p}`);
  assert.ok(rm.args.includes('--ignore-unmatch'));

  const checkout = git.find((c) => c.args.includes('checkout') && c.args.includes(HARNESS));
  assert.ok(checkout, 'checks out the harness paths');
  const paths = checkout.args.slice(checkout.args.indexOf('--') + 1);
  assert.ok(paths.includes('.claude/skills'));
  assert.ok(paths.includes('CLAUDE.md'));
  assert.ok(paths.includes('scripts/integration-check.mjs'));
  assert.ok(!paths.includes('skills-lock.json'), 'paths missing at harnessSha are skipped');
  for (const banned of ['.claude/worktrees', '.claude/metrics', '.claude/settings.local.json'])
    assert.ok(!HARNESS_OVERLAY_PATHS.includes(banned) && !paths.includes(banned), banned);

  // package.json: only the four harness script keys are merged in.
  const hash = git.find((c) => c.args.includes('hash-object'));
  const merged = JSON.parse(hash.input);
  assert.equal(merged.scripts.dev, 'vite');
  assert.equal(merged.scripts['worktree:setup'], 'node scripts/worktree-setup.mjs');
  assert.equal(merged.scripts['integration-check'], 'node scripts/integration-check.mjs');
  assert.equal(merged.scripts['eval:harness'], undefined);
  assert.ok(
    git.some((c) =>
      c.line.includes(`update-index --cacheinfo 100644,${'f'.repeat(40)},package.json`)
    )
  );

  const commit = git.find((c) => c.args.includes('commit'));
  assert.ok(commit.args.includes('--no-verify'));
  assert.ok(commit.args.includes('user.name=restura-harness-eval'));
  assert.equal(commit.args.at(-1), 'harness overlay @ abcdef012345');
});

test('overlayHarness fails loudly when the overlay commit cannot be made', async () => {
  const exec = fakeExec((command, args) =>
    command === 'git' && args.includes('commit')
      ? { status: 1, stdout: '', stderr: 'nope' }
      : undefined
  );
  await assert.rejects(overlayHarness(exec, '/w', HARNESS), /harness overlay.*nope/);
});

test('mergePackageScripts merges only the harness script keys and keeps formatting', () => {
  const merged = mergePackageScripts(BASE_PKG, HARNESS_PKG);
  assert.ok(merged.endsWith('}\n'));
  assert.match(merged, /\n {4}"dev": "vite",\n/);
  const parsed = JSON.parse(merged);
  assert.deepEqual(Object.keys(parsed.scripts), [
    'dev',
    'worktree:setup',
    'integration-check',
    'verify:agent-report',
    'worktree:prune',
  ]);
  assert.equal(parsed.name, 'restura');
  // Nothing to merge: returned byte-for-byte.
  const odd = '{ "name": "x",   "scripts": {"dev": "vite"} }';
  assert.equal(mergePackageScripts(odd, '{"scripts": {"dev": "other"}}'), odd);
  assert.equal(mergePackageScripts(odd, ''), odd);
});

// ---------------------------------------------------------------- transcripts

const STREAM = [
  { type: 'system', subtype: 'init', session_id: 'sess' },
  {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Starting' },
        {
          type: 'tool_use',
          id: '1',
          name: 'Skill',
          input: { skill: 'ship-check', args: '--quick' },
        },
      ],
    },
  },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: '1' }] } },
  {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: '2',
          name: 'Task',
          input: { subagent_type: 'restura-parity-checker' },
        },
        {
          type: 'tool_use',
          id: '3',
          name: 'Agent',
          input: { subagent_type: 'restura-security-auditor' },
        },
        { type: 'tool_use', id: '4', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_use', id: '5', name: 'Skill', input: { skill: 'code-review' } },
      ],
    },
  },
  {
    type: 'result',
    subtype: 'success',
    result: 'NOT READY: finding',
    total_cost_usd: 3.5,
    duration_ms: 90000,
    num_turns: 12,
    is_error: false,
    session_id: 'sess',
    permission_denials: [],
  },
]
  .map((e) => JSON.stringify(e))
  .join('\n');

test('parseClaudeStream returns the parseClaudeJson shape plus tool routing stats', () => {
  const parsed = parseClaudeStream(`${STREAM}\n`);
  assert.deepEqual(parsed, {
    text: 'NOT READY: finding',
    subtype: 'success',
    costUsd: 3.5,
    durationMs: 90000,
    numTurns: 12,
    isError: false,
    sessionId: 'sess',
    permissionDenials: [],
    toolStats: {
      toolCalls: 5,
      skills: ['ship-check', 'code-review'],
      agents: ['restura-parity-checker', 'restura-security-auditor'],
    },
  });
  assert.throws(() => parseClaudeStream(STREAM.split('\n').slice(0, 2).join('\n')), /result event/);
  // A truncated trailing line is tolerated as long as the result event is there.
  assert.equal(parseClaudeStream(`${STREAM}\n{"type":"assi`).text, 'NOT READY: finding');
});

test('classifyClaudeRun with the stream parser keeps error semantics', () => {
  const denied = STREAM.replace(
    '"permission_denials":[]',
    '"permission_denials":[{"tool_name":"Bash"}]'
  );
  const run = classifyClaudeRun({ status: 0, stdout: denied, stderr: '' }, parseClaudeStream);
  assert.equal(run.status, 'error');
  assert.match(run.reason, /permission denied: Bash/);
  const okRun = classifyClaudeRun({ status: 0, stdout: STREAM, stderr: '' }, parseClaudeStream);
  assert.equal(okRun.status, 'ok');
  assert.equal(okRun.parsed.toolStats.toolCalls, 5);
  const noResult = classifyClaudeRun(
    { status: 0, stdout: '{"type":"system"}', stderr: '' },
    parseClaudeStream
  );
  assert.equal(noResult.status, 'error');
  assert.match(noResult.reason, /unparseable/);
});

test('runCase writes the raw review stream to the transcript file and records it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'he-transcript-test-'));
  try {
    const transcriptFile = path.join(dir, 'transcripts', 'mcp-panel-collapse-run1.jsonl');
    const review = reviewJson('McpConnectionPanel shrink-0');
    const result = await runCase(
      defectCase(),
      reviewCtx(reviewExec(review, judgeJson('{"caught": true, "score": 3}')), {
        transcriptFile,
        transcriptLink: 'stamp--current/transcripts/mcp-panel-collapse-run1.jsonl',
      })
    );
    assert.equal(fs.readFileSync(transcriptFile, 'utf8'), review.stdout);
    assert.equal(result.transcript, 'stamp--current/transcripts/mcp-panel-collapse-run1.jsonl');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runCase passes --model to the reviewer and the judge model to the judge', async () => {
  const exec = reviewExec(
    reviewJson('McpConnectionPanel'),
    judgeJson('{"caught": true, "score": 3}')
  );
  await runCase(defectCase(), reviewCtx(exec, { model: 'opus', judgeModel: 'haiku' }));
  const [review, judge] = exec.calls.filter((c) => c.command === 'claude');
  assert.match(review.args.join(' '), /--model opus/);
  assert.match(judge.args.join(' '), /--model haiku/);
});

// ---------------------------------------------------------------- judge consistency

test('majorityVerdict: caught on a strict majority, ties are not caught', () => {
  const v = (caught, score) => ({ caught, score, reason: '' });
  assert.equal(majorityVerdict([v(true, 3)]).caught, true);
  assert.equal(majorityVerdict([v(true, 3), v(false, 1)]).caught, false);
  const three = majorityVerdict([v(true, 3), v(false, 1), v(true, 2)]);
  assert.equal(three.caught, true);
  assert.equal(three.score, 2);
  assert.equal(three.disagreement, true);
  assert.equal(three.verdicts.length, 3);
  assert.equal(majorityVerdict([v(false, 0), v(false, 1)]).disagreement, false);
});

test('runCase --judge-repeat grades the same review N times and records disagreements', async () => {
  const verdicts = [
    '{"caught": true, "score": 3, "reason": "a"}',
    '{"caught": false, "score": 1, "reason": "b"}',
    '{"caught": true, "score": 2, "reason": "c"}',
  ];
  let judgeCall = 0;
  const exec = fakeExec((command, _args, calls) => {
    if (command !== 'claude') return undefined;
    if (calls.filter((c) => c.command === 'claude').length === 1)
      return reviewJson('McpConnectionPanel shrink-0');
    const result = verdicts[judgeCall];
    judgeCall += 1;
    return { status: 0, stdout: JSON.stringify({ result, total_cost_usd: 0.1 }), stderr: '' };
  });
  const result = await runCase(defectCase(), reviewCtx(exec, { judgeRepeat: 3 }));
  assert.equal(exec.calls.filter((c) => c.command === 'claude').length, 4);
  assert.equal(result.judge.verdicts.length, 3);
  assert.equal(result.judgeCaught, true);
  assert.equal(result.judgeDisagreement, true);
  assert.equal(result.caught, true);
  assert.ok(Math.abs(result.judgeCostUsd - 0.3) < 1e-9);
  const summary = summarise([{ ...result, status: 'ok' }]);
  assert.equal(summary.cases['mcp-panel-collapse'].judgeDisagreements, 1);
  assert.equal(summary.judgeDisagreements, 1);
});

// ---------------------------------------------------------------- metrics

test('passAtK / passHatK are the unbiased estimators', () => {
  assert.equal(passAtK(3, 0, 3), 0);
  assert.equal(passAtK(3, 1, 3), 1);
  assert.equal(passHatK(3, 2, 3), 0);
  assert.equal(passHatK(3, 3, 3), 1);
  // n=4, c=2, k=2: pass@2 = 1 - C(2,2)/C(4,2) = 5/6; pass^2 = C(2,2)/C(4,2) = 1/6.
  assert.ok(Math.abs(passAtK(4, 2, 2) - 5 / 6) < 1e-9);
  assert.ok(Math.abs(passHatK(4, 2, 2) - 1 / 6) < 1e-9);
  assert.equal(passAtK(0, 0, 0), null);
  assert.equal(passHatK(0, 0, 0), null);
});

test('wilsonInterval matches the textbook 95% interval', () => {
  const ci = wilsonInterval(8, 10);
  assert.ok(Math.abs(ci.low - 0.4902) < 1e-3, String(ci.low));
  assert.ok(Math.abs(ci.high - 0.9433) < 1e-3, String(ci.high));
  assert.ok(Math.abs(ci.halfWidth - (ci.high - ci.low) / 2) < 1e-9);
  assert.equal(wilsonInterval(0, 0), null);
  assert.equal(wilsonInterval(0, 5).low, 0);
});

test('summarise aggregates skill and agent routing across runs', () => {
  const stats = (skills, agents) => ({ review: { toolStats: { toolCalls: 3, skills, agents } } });
  const summary = summarise([
    {
      caseId: 'a',
      status: 'ok',
      caught: true,
      ...stats(['ship-check', 'code-review'], ['restura-parity-checker']),
    },
    {
      caseId: 'a',
      status: 'ok',
      caught: true,
      ...stats(['ship-check'], ['restura-parity-checker', 'restura-parity-checker']),
    },
    { caseId: 'b', status: 'error', caught: null },
  ]);
  assert.deepEqual(summary.toolStats, {
    runs: 2,
    toolCalls: 6,
    skills: { 'ship-check': { runs: 2, calls: 2 }, 'code-review': { runs: 1, calls: 1 } },
    agents: { 'restura-parity-checker': { runs: 2, calls: 3 } },
  });
});

test('formatSummaryMarkdown shows pass@k, CIs, noise, cost, transcripts and routing', () => {
  const run = (k, caught) => ({
    caseId: 'a',
    run: k,
    status: 'ok',
    expectClean: false,
    caught,
    judgeCaught: caught,
    patternCaught: caught,
    judge: { caught, score: 3, reason: '' },
    review: {
      costUsd: 1,
      durationMs: 60000,
      toolStats: { toolCalls: 2, skills: ['ship-check'], agents: [] },
    },
    judgeCostUsd: 0.25,
    transcript: `s--current/transcripts/a-run${k}.jsonl`,
  });
  const md = formatSummaryMarkdown(
    {
      config: 'current',
      startedAt: '2026-10-25T00:00:00.000Z',
      dryRun: false,
      harnessSha: HARNESS,
      runs: [run(1, true), run(2, false)],
    },
    undefined
  );
  // pass@1 (per-trial rate) compares across run counts; pass@n / pass^n carry the actual n.
  assert.match(md, /\| pass@1 \| pass@2 \| pass\^2 \|/);
  assert.match(md, /\| a \| defect \| 1\/2 \| 0 \| YES \| 0\.50 \| 1\.00 \| 0\.00 \|/);
  assert.match(md, /pass@1 \(per-trial rate\): defects 50%/);
  assert.doesNotMatch(md, /pass@k|pass\^k/);
  const mixed = formatSummaryMarkdown(
    {
      config: 'current',
      startedAt: '2026-10-25T00:00:00.000Z',
      dryRun: false,
      runs: [run(1, true), run(2, true), { ...run(1, true), caseId: 'b' }],
    },
    undefined
  );
  assert.match(mixed, /\| pass@1 \| pass@n \| pass\^n \|/);
  assert.match(mixed, /\| 1\.00 \(n=2\) \|/);
  assert.match(md, /95% CI/);
  assert.match(md, /Noise: 1 case flipped/);
  assert.match(md, /half-width/);
  assert.match(md, /\[1\]\(s--current\/transcripts\/a-run1\.jsonl\)/);
  assert.match(md, /ship-check/);
  assert.match(md, /\| 1\.25 \|/);
  assert.match(md, /abcdef012345/);
});

// ---------------------------------------------------------------- split

test('validateCase requires split: train | test', () => {
  const missing = validateCase(validRaw({ split: undefined }), env);
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join('\n'), /split/);
  assert.equal(validateCase(validRaw({ split: 'dev' }), env).ok, false);
  assert.equal(validateCase(validRaw({ split: 'test' }), env).value.split, 'test');
});

test('the real case set keeps a usable held-out split (properties, not a case list)', () => {
  const cases = loadCases();
  assert.ok(cases.every((c) => c.split === 'train' || c.split === 'test'));
  const heldOut = cases.filter((c) => c.split === 'test');
  assert.ok(
    heldOut.some((c) => c.expectClean),
    'test split needs at least one control'
  );
  assert.ok(
    heldOut.some((c) => !c.expectClean),
    'test split needs at least one defect'
  );
  const fraction = heldOut.length / cases.length;
  assert.ok(fraction >= 0.2 && fraction <= 0.4, `test fraction ${fraction.toFixed(2)}`);
});

test('loadCases filters by split (fixture cases)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'he-split-test-'));
  try {
    const casesDir = path.join(root, 'cases');
    const fixturesDir = path.join(root, 'fixtures');
    fs.mkdirSync(casesDir);
    const make = (id, split, clean) => {
      fs.mkdirSync(path.join(fixturesDir, id), { recursive: true });
      fs.writeFileSync(path.join(fixturesDir, id, '01.patch'), '');
      const raw = clean
        ? cleanRaw({ id, split, branches: [{ name: 'b', patches: ['01.patch'] }] })
        : validRaw({ id, split, branches: [{ name: 'b', patches: ['01.patch'] }] });
      fs.writeFileSync(path.join(casesDir, `${id}.yaml`), JSON.stringify(raw));
    };
    make('case-a', 'train', false);
    make('case-b', 'test', false);
    make('case-c', 'test', true);
    const ids = (split) => loadCases({ casesDir, fixturesDir, split }).map((c) => c.id);
    assert.deepEqual(ids('test'), ['case-b', 'case-c']);
    assert.deepEqual(ids('train'), ['case-a']);
    assert.deepEqual(ids('all'), ['case-a', 'case-b', 'case-c']);
    assert.deepEqual(
      loadCases({ casesDir, fixturesDir, split: 'test', ids: ['case-c'] }).map((c) => c.id),
      ['case-c']
    );
    assert.throws(
      () => loadCases({ casesDir, fixturesDir, split: 'test', ids: ['case-a'] }),
      /not in split test/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- baselines

test('buildBaseline is summary-only and diffFlips accepts it on either side', () => {
  const fullRun = (k) => ({
    caseId: 'a',
    run: k,
    status: 'ok',
    expectClean: false,
    caught: true,
    review: { text: 'SECRET REVIEW TEXT', costUsd: 1 },
    transcript: `x/transcripts/a-run${k}.jsonl`,
    judge: { score: 3, reason: 'JUDGE REASON' },
  });
  const result = {
    config: 'A',
    startedAt: '2026-10-25T00:00:00.000Z',
    harnessSha: HARNESS,
    runsPerCase: 2,
    model: 'opus',
    judgeModel: 'sonnet',
    split: 'all',
    runs: [fullRun(1), fullRun(2)],
  };
  const baseline = buildBaseline(result);
  const text = JSON.stringify(baseline);
  assert.doesNotMatch(text, /SECRET REVIEW TEXT|JUDGE REASON|transcripts/);
  assert.equal(baseline.config, 'A');
  assert.equal(baseline.harnessSha, HARNESS);
  assert.equal(baseline.runsPerCase, 2);
  assert.equal(baseline.cases.a.caught, 2);
  assert.equal(baseline.cases.a.passAtK, 1);
  assert.equal(baseline.cases.a.passAt1, 1);
  assert.deepEqual(baseline.passAt1, { defects: 1, controls: null });
  assert.ok(baseline.recall.ci);
  assert.equal(baseline.runs, undefined);
  const current = { runs: [{ caseId: 'a', status: 'ok', expectClean: false, caught: false }] };
  assert.deepEqual(diffFlips(baseline, current), [
    { caseId: 'a', type: 'defect', before: '2/2', after: '0/1', kind: 'regressed' },
  ]);
  assert.deepEqual(diffFlips(current, baseline), [
    { caseId: 'a', type: 'defect', before: '0/1', after: '2/2', kind: 'improved' },
  ]);
});

test('baselinePath uses a UTC minute stamp and writeBaseline never overwrites', () => {
  const result = {
    config: 'A',
    startedAt: '2026-10-25T06:31:46.761Z',
    runsPerCase: 1,
    runs: [{ caseId: 'a', status: 'ok', expectClean: false, caught: true }],
  };
  assert.equal(baselinePath(result, '/b'), '/b/2026-10-25T0631--A.json');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'he-baseline-test-'));
  try {
    const file = writeBaseline(result, dir);
    assert.equal(file, path.join(dir, '2026-10-25T0631--A.json'));
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).config, 'A');
    assert.throws(() => writeBaseline(result, dir), /already exists/);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).cases.a.caught, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- isolated repo

test('createIsolatedRepo builds base + overlay from archives and never mutates the main repo', async () => {
  const exec = fakeExec((command, args) =>
    command === 'git' && args.includes('cat-file') && args.at(-1) === `${HARNESS}:skills-lock.json`
      ? { status: 128, stdout: '', stderr: 'missing' }
      : undefined
  );
  const result = await createIsolatedRepo(exec, {
    dir: '/tmp/iso',
    baseSha: BASE,
    harnessSha: HARNESS,
    repo: '/repo',
  });
  assert.deepEqual(result, { harnessSha: HARNESS, effectiveBase: EFFECTIVE });
  const joined = lines(exec);
  assert.match(joined, /^git init -q --initial-branch=main \/tmp\/iso$/m);
  assert.ok(joined.includes(`git -C /repo archive ${BASE} | tar -x -f - -C /tmp/iso`));
  assert.match(joined, /-C \/tmp\/iso .*commit -q --no-verify -m base$/m);
  const overlay = exec.calls.find(
    (c) => c.command === 'pipe' && c.from[1].includes(HARNESS) && c.from[1].includes('archive')
  );
  assert.ok(overlay, 'overlay paths come from an archive of harnessSha');
  const paths = overlay.from[1].slice(overlay.from[1].indexOf('--') + 1);
  assert.ok(paths.includes('.claude/skills') && paths.includes('CLAUDE.md'));
  assert.ok(!paths.includes('skills-lock.json'));
  assert.match(
    joined,
    /-C \/tmp\/iso .*commit -q --no-verify --allow-empty -m harness overlay @ abcdef012345/
  );
  assert.match(joined, new RegExp(`-C /tmp/iso update-ref refs/remotes/origin/main ${EFFECTIVE}`));
  assert.doesNotMatch(joined, /remote add|worktree add|fetch/);
  assertMainRepoReadOnly(exec);
  // No shell: every process is spawned with an argv array.
  assert.ok(exec.calls.every((c) => c.command === 'git' || c.command === 'pipe'));
});

function gitSync(cwd, ...args) {
  const result = syncExec.run(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { cwd }
  );
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

test('createIsolatedRepo (real git): two commits only, overlay present, origin/main resolves', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'he-iso-test-'));
  try {
    const repo = path.join(root, 'src');
    fs.mkdirSync(repo);
    gitSync(repo, 'init', '-q', '--initial-branch=main');
    const write = (rel, text) => {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      fs.writeFileSync(path.join(repo, rel), text);
    };
    write('package.json', BASE_PKG);
    write('src/app.ts', 'export const x = 1;\n');
    write('.claude/commands/ship-check.md', 'old command\n');
    gitSync(repo, 'add', '-A');
    gitSync(repo, 'commit', '-q', '-m', 'old base');
    const baseSha = gitSync(repo, 'rev-parse', 'HEAD');
    write('src/app.ts', 'export const x = 2;\n');
    gitSync(repo, 'commit', '-q', '-am', 'fix(app): the answer the reviewer must not see');
    fs.rmSync(path.join(repo, '.claude/commands'), { recursive: true });
    write('.claude/skills/ship-check/SKILL.md', 'new skill\n');
    write('CLAUDE.md', 'harness doc\n');
    write('package.json', HARNESS_PKG);
    gitSync(repo, 'add', '-A');
    gitSync(repo, 'commit', '-q', '-m', 'harness');
    const harnessSha = gitSync(repo, 'rev-parse', 'HEAD');

    const dir = path.join(root, 'iso');
    const { effectiveBase } = await createIsolatedRepo(nodeExec, {
      dir,
      baseSha,
      harnessSha,
      repo,
    });
    const subjects = gitSync(dir, 'log', '--all', '--format=%s').split('\n');
    assert.deepEqual(subjects, [`harness overlay @ ${harnessSha.slice(0, 12)}`, 'base']);
    assert.equal(gitSync(dir, 'rev-parse', 'origin/main'), effectiveBase);
    assert.equal(gitSync(dir, 'rev-parse', 'main'), effectiveBase);
    assert.equal(gitSync(dir, 'remote'), '');
    assert.equal(
      fs.readFileSync(path.join(dir, '.claude/skills/ship-check/SKILL.md'), 'utf8'),
      'new skill\n'
    );
    assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), 'harness doc\n');
    assert.ok(!fs.existsSync(path.join(dir, '.claude/commands')), 'base harness removed');
    // Product code stays at the base; the later fix is unreachable.
    assert.equal(fs.readFileSync(path.join(dir, 'src/app.ts'), 'utf8'), 'export const x = 1;\n');
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts.dev, 'vite');
    assert.equal(pkg.scripts['integration-check'], 'node scripts/integration-check.mjs');
    assert.equal(gitSync(dir, 'status', '--porcelain'), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('linkNodeModules links the main checkout node_modules into a non-worktree dir', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'he-link-test-'));
  try {
    const main = path.join(root, 'main');
    const dir = path.join(root, 'iso');
    for (const p of ['node_modules', 'cli/node_modules'])
      fs.mkdirSync(path.join(main, p), { recursive: true });
    fs.writeFileSync(path.join(main, 'package.json'), '{"workspaces":["cli"]}');
    fs.writeFileSync(path.join(main, 'cli/package.json'), '{}');
    fs.mkdirSync(path.join(dir, 'cli'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'cli/package.json'), '{}');
    const linked = linkNodeModules(dir, main);
    assert.deepEqual(linked, ['.', 'cli']);
    assert.equal(
      fs.realpathSync(path.join(dir, 'node_modules')),
      fs.realpathSync(path.join(main, 'node_modules'))
    );
    assert.ok(fs.lstatSync(path.join(dir, 'cli/node_modules')).isSymbolicLink());
    assert.deepEqual(linkNodeModules(dir, main), ['.', 'cli'], 'idempotent');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- contamination

const MAIN = path.join(path.sep, 'srv', 'checkout', 'restura');
const ISO = '/tmp/he/repo';
const toolStream = (...uses) =>
  [
    { type: 'system', subtype: 'init' },
    {
      type: 'assistant',
      message: {
        content: uses.map(([name, input], i) => ({ type: 'tool_use', id: `t${i}`, name, input })),
      },
    },
    { type: 'result', subtype: 'success', result: 'done', is_error: false },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');
const roots = { forbiddenRoots: [MAIN, `/private${MAIN}`], isolatedRoot: ISO };

test('detectContamination ignores in-repo work and paths that merely share a prefix', () => {
  const clean = toolStream(
    ['Bash', { command: 'git diff main...feat/x && git -C /tmp/he/repo/sub status' }],
    ['Read', { file_path: `${ISO}/src/a.ts` }],
    ['Read', { file_path: `${MAIN}-other/notes.md` }],
    ['Grep', { pattern: 'restura', path: `${MAIN}X` }],
    ['Bash', { command: 'git log --oneline -5' }]
  );
  // A forbidden path in a tool RESULT (not an input) does not count.
  const withResult = `${clean}\n${JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't0', content: `${MAIN}/x` }] },
  })}`;
  assert.deepEqual(detectContamination(withResult, roots), { contaminated: false, hits: [] });
});

test('detectContamination flags explicit main-checkout paths and git escapes', () => {
  const stream = toolStream(
    ['Bash', { command: `cd ${MAIN} && git log --all` }],
    ['Read', { file_path: `${MAIN}/src/app.ts` }],
    ['Grep', { pattern: 'fix', path: `/private${MAIN}` }],
    ['Bash', { command: 'git -C /tmp/elsewhere log --all' }],
    ['Bash', { command: "git --git-dir='/x/.git' show HEAD" }],
    ['Bash', { command: 'git -C ../.. log' }],
    ['Bash', { command: 'GIT_DIR=/y/.git git log' }],
    ['Glob', { pattern: '**/*.ts', path: MAIN }]
  );
  const result = detectContamination(stream, roots);
  assert.equal(result.contaminated, true);
  assert.deepEqual(
    result.hits.map((h) => h.tool),
    ['Bash', 'Read', 'Grep', 'Bash', 'Bash', 'Bash', 'Bash', 'Glob']
  );
  assert.ok(result.hits.every((h) => typeof h.snippet === 'string' && h.snippet.length > 0));
  assert.ok(result.hits[0].snippet.includes(MAIN));
  // Without an isolated root, only forbidden roots count.
  const rootsOnly = detectContamination(
    toolStream(['Bash', { command: 'git -C /tmp/elsewhere log' }]),
    { forbiddenRoots: [MAIN] }
  );
  assert.equal(rootsOnly.contaminated, false);
});

test('runCase marks a contaminated review as a harness error and skips the judge', async () => {
  const contaminated = {
    status: 0,
    stdout: toolStream(['Bash', { command: `git -C ${MAIN} log --all` }]),
    stderr: '',
  };
  const exec = reviewExec(contaminated, judgeJson('{"caught": true, "score": 3}'));
  const result = await runCase(defectCase(), reviewCtx(exec, { forbiddenRoots: [MAIN] }));
  assert.equal(result.status, 'error');
  assert.match(result.reason, /^contaminated: /);
  assert.equal(result.caught, null);
  assert.equal(result.contamination.length, 1);
  assert.equal(exec.calls.filter((c) => c.command === 'claude').length, 1, 'no judge call');
  const md = formatSummaryMarkdown(
    {
      config: 'c',
      startedAt: '2026-10-25T00:00:00.000Z',
      dryRun: false,
      runs: [{ ...result, run: 1 }],
    },
    undefined
  );
  assert.match(md, /contaminated: /);
  assert.ok(md.includes(`git -C ${MAIN} log --all`));
});
