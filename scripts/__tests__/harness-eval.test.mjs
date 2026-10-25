import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildJudgePrompt,
  buildReviewPrompt,
  diffFlips,
  formatSummaryMarkdown,
  gradeMustMention,
  parseClaudeJson,
  parseEvalArgs,
  parseJudgeVerdict,
  runCase,
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

const allExist = () => true;

test('validateCase accepts a well-formed case and normalises it', () => {
  const result = validateCase(validRaw(), { fileExists: allExist, fixturesDir: '/fx' });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(result.value.id, 'mcp-panel-collapse');
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
    { fileExists: allExist, fixturesDir: '/fx' }
  );
  assert.equal(result.ok, false);
  const text = result.errors.join('\n');
  assert.match(text, /id/);
  assert.match(text, /origin/);
  assert.match(text, /base/);
  assert.match(text, /branches/);
  assert.match(text, /mustMention\[0\]/);
  assert.match(text, /mustNotMiss/);
  assert.match(text, /expected\.defect/);
  assert.match(text, /expected\.files/);
});

test('validateCase requires real cases to cite source PRs and patch files to exist', () => {
  const result = validateCase(validRaw({ sourcePRs: [] }), {
    fileExists: (p) => !p.endsWith('b.patch'),
    fixturesDir: '/fx',
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /sourcePRs/);
  assert.match(result.errors.join('\n'), /b\.patch/);
  const synthetic = validateCase(validRaw({ origin: 'synthetic', sourcePRs: [] }), {
    fileExists: allExist,
    fixturesDir: '/fx',
  });
  assert.equal(synthetic.ok, true);
});

test('validateCase rejects duplicate branch names and path-escaping patches', () => {
  const result = validateCase(
    validRaw({
      branches: [
        { name: 'dup', patches: ['a.patch'] },
        { name: 'dup', patches: ['../../etc/passwd'] },
      ],
    }),
    { fileExists: allExist, fixturesDir: '/fx' }
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /duplicate branch/);
  assert.match(result.errors.join('\n'), /inside the case fixture dir/);
});

test('gradeMustMention is case-insensitive and lists misses', () => {
  const graded = gradeMustMention('The mcpConnectionPanel row has two SHRINK-0 buttons', [
    'McpConnectionPanel',
    'shrink-0',
    'flex-wrap',
  ]);
  assert.deepEqual(graded.passed, ['McpConnectionPanel', 'shrink-0']);
  assert.deepEqual(graded.missed, ['flex-wrap']);
  assert.equal(graded.allPassed, false);
  assert.equal(gradeMustMention('anything', []).allPassed, true);
});

test('parseClaudeJson extracts text, cost and duration', () => {
  const parsed = parseClaudeJson(
    JSON.stringify({
      type: 'result',
      result: 'NOT READY',
      total_cost_usd: 1.25,
      duration_ms: 4200,
      num_turns: 7,
      is_error: false,
      session_id: 's1',
    })
  );
  assert.deepEqual(parsed, {
    text: 'NOT READY',
    costUsd: 1.25,
    durationMs: 4200,
    numTurns: 7,
    isError: false,
    sessionId: 's1',
  });
  assert.throws(() => parseClaudeJson('not json'), /claude JSON/);
});

test('parseJudgeVerdict accepts fenced or prose-wrapped JSON and clamps the score', () => {
  assert.deepEqual(
    parseJudgeVerdict(
      'Here you go:\n```json\n{"caught": true, "score": 3, "reason": "named it"}\n```'
    ),
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

test('buildReviewPrompt names every branch and the base but never leaks the expected defect', () => {
  const evalCase = validateCase(validRaw(), { fileExists: allExist, fixturesDir: '/fx' }).value;
  const prompt = buildReviewPrompt(evalCase, [
    'eval/r1/feat/mcp-import',
    'eval/r1/feat/mcp-conformance',
  ]);
  assert.match(prompt, /^\/ship-check /);
  assert.match(prompt, /eval\/r1\/feat\/mcp-import eval\/r1\/feat\/mcp-conformance/);
  assert.match(prompt, new RegExp(BASE));
  assert.doesNotMatch(prompt, /shrink-0|squeezed|McpConnectionPanel/);
});

test('buildJudgePrompt embeds the rubric, the expected defect and the review', () => {
  const evalCase = validateCase(validRaw(), { fileExists: allExist, fixturesDir: '/fx' }).value;
  const prompt = buildJudgePrompt({
    rubric: 'RUBRIC-TEXT',
    evalCase,
    reviewText: 'REVIEW-TEXT',
  });
  assert.match(prompt, /RUBRIC-TEXT/);
  assert.match(prompt, /squeezed to 2px/);
  assert.match(prompt, /REVIEW-TEXT/);
  assert.match(prompt, /McpConnectionPanel\.tsx/);
});

test('summarise counts caught runs and flags inconsistent cases', () => {
  const summary = summarise([
    { caseId: 'a', run: 1, caught: true, judge: { score: 3 } },
    { caseId: 'a', run: 2, caught: false, judge: { score: 1 } },
    { caseId: 'b', run: 1, caught: true, judge: { score: 2 } },
    { caseId: 'b', run: 2, caught: true, judge: null },
  ]);
  assert.deepEqual(summary.a, { runs: 2, caught: 1, flipped: true, meanScore: 2 });
  assert.deepEqual(summary.b, { runs: 2, caught: 2, flipped: false, meanScore: 2 });
});

test('diffFlips reports cases whose caught outcome changed between invocations', () => {
  const previous = {
    config: 'current',
    runs: [
      { caseId: 'a', run: 1, caught: true },
      { caseId: 'a', run: 2, caught: true },
      { caseId: 'b', run: 1, caught: false },
      { caseId: 'c', run: 1, caught: true },
    ],
  };
  const current = {
    config: 'skills',
    runs: [
      { caseId: 'a', run: 1, caught: false },
      { caseId: 'a', run: 2, caught: false },
      { caseId: 'b', run: 1, caught: false },
      { caseId: 'b', run: 2, caught: true },
      { caseId: 'd', run: 1, caught: true },
    ],
  };
  assert.deepEqual(diffFlips(previous, current), [
    { caseId: 'a', before: '2/2', after: '0/2', kind: 'regressed' },
    { caseId: 'b', before: '0/1', after: '1/2', kind: 'improved' },
  ]);
});

test('formatSummaryMarkdown includes per-case rows and the flip table', () => {
  const md = formatSummaryMarkdown(
    {
      config: 'current',
      startedAt: '2026-10-25T00:00:00.000Z',
      dryRun: false,
      runs: [
        {
          caseId: 'a',
          run: 1,
          caught: true,
          deterministic: { allPassed: true, passed: ['x'], missed: [] },
          judge: { caught: true, score: 3, reason: 'ok' },
          review: { costUsd: 1.5, durationMs: 60000 },
        },
      ],
    },
    [{ caseId: 'a', before: '0/1', after: '1/1', kind: 'improved' }]
  );
  assert.match(md, /\| a \| 1\/1 \|/);
  assert.match(md, /Flips/);
  assert.match(md, /improved/);
});

test('parseEvalArgs applies defaults and validates numbers', () => {
  const defaults = parseEvalArgs([]);
  assert.equal(defaults.runs, 2);
  assert.equal(defaults.config, 'current');
  assert.equal(defaults.dryRun, false);
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
  assert.throws(() => parseEvalArgs(['--runs', '0']), /--runs/);
  assert.throws(() => parseEvalArgs(['--config', 'has space']), /--config/);
  assert.throws(() => parseEvalArgs(['--bogus']), /Unknown option/);
});

/** Records every command; fails `claude` so cleanup-on-error is exercised. */
function fakeExec({ failOn } = {}) {
  const calls = [];
  return {
    calls,
    run(command, args) {
      calls.push([command, ...args].join(' '));
      if (failOn && failOn(command, args)) return { status: 1, stdout: '', stderr: 'boom' };
      if (command === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: `${BASE}\n` };
      return { status: 0, stdout: '', stderr: '' };
    },
  };
}

test('runCase dry-run applies patches, checks the combined merge and always cleans up', () => {
  const evalCase = validateCase(validRaw(), { fileExists: allExist, fixturesDir: '/fx' }).value;
  const exec = fakeExec();
  const result = runCase(evalCase, {
    exec,
    repo: '/repo',
    tempDir: '/tmp/he',
    runId: 'r1',
    dryRun: true,
  });
  assert.equal(result.applied, true);
  assert.equal(result.combinedMerge, 'clean');
  const joined = exec.calls.join('\n');
  assert.match(joined, /worktree add --detach \/tmp\/he\/worktree 90b514e3/);
  assert.match(joined, /apply --index \/fx\/mcp-panel-collapse\/a\.patch/);
  assert.match(joined, /branch -D harness-eval\/r1\/feat\/mcp-import/);
  assert.match(joined, /worktree remove --force \/tmp\/he\/worktree/);
  assert.doesNotMatch(joined, /^claude/m);
});

test('runCase cleans up the worktree and branches when a patch fails to apply', () => {
  const evalCase = validateCase(validRaw(), { fileExists: allExist, fixturesDir: '/fx' }).value;
  const exec = fakeExec({
    failOn: (command, args) =>
      command === 'git' && args.includes('apply') && args.at(-1).endsWith('b.patch'),
  });
  const result = runCase(evalCase, {
    exec,
    repo: '/repo',
    tempDir: '/tmp/he',
    runId: 'r1',
    dryRun: true,
  });
  assert.equal(result.applied, false);
  assert.match(result.error, /b\.patch/);
  const joined = exec.calls.join('\n');
  assert.match(joined, /worktree remove --force \/tmp\/he\/worktree/);
  assert.match(joined, /branch -D harness-eval\/r1\/feat\/mcp-import/);
});

test('runCase review mode invokes claude with the ship-check prompt and the judge', () => {
  const evalCase = validateCase(validRaw(), { fileExists: allExist, fixturesDir: '/fx' }).value;
  const calls = [];
  const exec = {
    run(command, args, opts = {}) {
      calls.push({ command, args, input: opts.input });
      if (command === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: BASE };
      if (command === 'claude' && calls.filter((c) => c.command === 'claude').length === 1) {
        return {
          status: 0,
          stdout: JSON.stringify({
            result: 'McpConnectionPanel: shrink-0 buttons squeeze the toggle',
            total_cost_usd: 2,
            duration_ms: 1000,
          }),
        };
      }
      if (command === 'claude') {
        return {
          status: 0,
          stdout: JSON.stringify({ result: '{"caught": true, "score": 3, "reason": "named"}' }),
        };
      }
      return { status: 0, stdout: '' };
    },
  };
  const result = runCase(evalCase, {
    exec,
    repo: '/repo',
    tempDir: '/tmp/he',
    runId: 'r1',
    dryRun: false,
    judge: true,
    rubric: 'RUBRIC',
    setup: () => {},
  });
  const claudeCalls = calls.filter((c) => c.command === 'claude');
  assert.equal(claudeCalls.length, 2);
  assert.match(claudeCalls[0].input, /^\/ship-check /);
  assert.match(claudeCalls[1].input, /RUBRIC/);
  assert.equal(result.review.costUsd, 2);
  assert.equal(result.deterministic.allPassed, true);
  assert.deepEqual(result.judge, { caught: true, score: 3, reason: 'named' });
  assert.equal(result.caught, true);
  assert.ok(
    calls.some((c) => c.command === 'git' && c.args.join(' ').includes('worktree remove --force'))
  );
});
