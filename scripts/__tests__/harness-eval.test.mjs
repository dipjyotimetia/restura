import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildJudgePrompt,
  buildReviewPrompt,
  classifyClaudeRun,
  cleanupTracked,
  cleanupTrackedAsync,
  decideCaught,
  diffFlips,
  formatSummaryMarkdown,
  gradeMustMention,
  loadCases,
  parseClaudeJson,
  parseEvalArgs,
  parseJudgeVerdict,
  parseWorktreePorcelain,
  runCase,
  selectLeftovers,
  summarise,
  validateCase,
} from '../harness-eval.mjs';

const BASE = '90b514e380786e4935058871113315c73e5b2539';

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

test('buildReviewPrompt uses ship-check --quick, names branches and base, never leaks the defect', () => {
  const prompt = buildReviewPrompt(defectCase(), [
    'harness-eval/r1/feat/mcp-import',
    'harness-eval/r1/feat/mcp-conformance',
  ]);
  assert.match(
    prompt,
    /^\/ship-check --quick harness-eval\/r1\/feat\/mcp-import harness-eval\/r1\/feat\/mcp-conformance\n/
  );
  assert.match(prompt, new RegExp(BASE));
  assert.doesNotMatch(prompt, /shrink-0|squeezed|McpConnectionPanel/);
  assert.doesNotMatch(buildReviewPrompt(cleanCase(), ['b']), /clean|control|byte cap/i);
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
    { caseId: 'a', status: 'ok', expectClean: false, caught: true, judge: { score: 3 } },
    { caseId: 'a', status: 'ok', expectClean: false, caught: false, judge: { score: 1 } },
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
  });
  assert.deepEqual(summary.cases.c, {
    expectClean: true,
    runs: 2,
    caught: 1,
    errors: 0,
    flipped: true,
    meanScore: 1.5,
  });
  assert.deepEqual(summary.recall, { caught: 1, runs: 2 });
  assert.deepEqual(summary.controls, { clean: 1, falsePositives: 1, runs: 2 });
  assert.equal(summary.errors, 1);
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

/** Records every command; `respond` may override a result. */
function fakeExec(respond = () => undefined) {
  const calls = [];
  return {
    calls,
    run(command, args, opts = {}) {
      calls.push({ command, args, input: opts.input, line: [command, ...args].join(' ') });
      const custom = respond(command, args, calls);
      if (custom) return custom;
      return { status: 0, stdout: command === 'git' ? '' : '{}', stderr: '' };
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
    tracker,
  });
  assert.equal(result.applied, true);
  assert.equal(result.combinedMerge, 'clean');
  const joined = lines(exec);
  assert.match(joined, /worktree add --detach \/tmp\/he\/worktree 90b514e3/);
  assert.match(joined, /apply --index \/fx\/mcp-panel-collapse\/a\.patch/);
  assert.match(joined, /branch -D harness-eval\/r1\/feat\/mcp-import/);
  assert.match(joined, /worktree remove --force \/tmp\/he\/worktree/);
  assert.doesNotMatch(joined, /^claude/m);
  assert.deepEqual(tracker, { worktree: null, branches: [] });
});

test('runCase cleans up the worktree and branches when a patch fails to apply', async () => {
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
  });
  assert.equal(result.applied, false);
  assert.equal(result.status, 'error');
  assert.match(result.reason, /b\.patch/);
  const joined = lines(exec);
  assert.match(joined, /worktree remove --force \/tmp\/he\/worktree/);
  assert.match(joined, /branch -D harness-eval\/r1\/feat\/mcp-import/);
});

const reviewJson = (text, extra = {}) => ({
  status: 0,
  stdout: JSON.stringify({
    subtype: 'success',
    result: text,
    total_cost_usd: 2,
    duration_ms: 1000,
    ...extra,
  }),
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
  assert.ok(claudeCalls[0].args.includes('--max-budget-usd'));
  assert.match(claudeCalls[1].input, /RUBRIC/);
  assert.equal(result.status, 'ok');
  assert.equal(result.review.costUsd, 2);
  assert.equal(result.judgeCaught, true);
  assert.equal(result.patternCaught, true);
  assert.equal(result.caught, true);
  assert.match(lines(exec), /worktree remove --force/);

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

test('runCase reports cleanup failures without hiding the run result', async () => {
  const exec = fakeExec((command, args) =>
    command === 'git' && args.includes('-D')
      ? { status: 1, stdout: '', stderr: 'locked' }
      : undefined
  );
  const tracker = { worktree: null, branches: [] };
  const result = await runCase(defectCase(), {
    exec,
    repo: '/repo',
    tempDir: '/tmp/he',
    runId: 'r1',
    dryRun: true,
    tracker,
  });
  assert.equal(result.applied, true);
  assert.equal(result.cleanupFailed.length, 2);
  assert.deepEqual(tracker.branches, [
    'harness-eval/r1/feat/mcp-import',
    'harness-eval/r1/feat/mcp-conformance',
  ]);
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
