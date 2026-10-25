import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyRedRun,
  compareClaimed,
  extractReport,
  filesOutsideOwnership,
  isTestPath,
  validateReport,
} from '../verify-agent-report.mjs';

const good = {
  branch: 'fix/x',
  worktree: '/repo/.claude/worktrees/agent-1',
  sha: 'a'.repeat(40),
  filesTouched: ['src/a.ts', 'src/a.test.ts'],
  redFirst: { command: 'npx vitest run src/a.test.ts', failingExcerpt: 'expected 1 to be 2' },
  gates: { tests: 'pass', lint: 'pass', typeCheckAll: 'pass' },
};

test('extracts the report from bare JSON or a fenced block inside prose', () => {
  assert.deepEqual(extractReport(JSON.stringify(good)), good);
  assert.deepEqual(extractReport(`Done!\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\`\nbye`), good);
  assert.equal(extractReport('no json here'), null);
});

test('accepts a complete report', () => {
  assert.deepEqual(validateReport(good), []);
});

test('rejects missing fields, a short sha and failing gates', () => {
  const problems = validateReport({
    ...good,
    sha: 'abc',
    redFirst: undefined,
    gates: { tests: 'fail' },
  });
  assert.ok(problems.some((p) => /sha/.test(p)));
  assert.ok(problems.some((p) => /redFirst/.test(p)));
  assert.ok(problems.some((p) => /gate tests/.test(p)));
});

test('red-first needs a command and a non-empty failing excerpt', () => {
  const problems = validateReport({ ...good, redFirst: { command: 'x', failingExcerpt: '' } });
  assert.ok(problems.some((p) => /failingExcerpt/.test(p)));
});

test('ownership: exact paths, directory prefixes and globs', () => {
  const owned = ['src/a.ts', 'shared/protocol/', 'tests/**/*.test.ts', 'docs/*.md'];
  assert.deepEqual(
    filesOutsideOwnership(
      [
        'src/a.ts',
        'shared/protocol/x/y.ts',
        'tests/security/z.test.ts',
        'docs/A.md',
        'docs/sub/B.md',
        'src/b.ts',
      ],
      owned
    ),
    ['docs/sub/B.md', 'src/b.ts']
  );
});

test('claimed vs actual: unclaimed changes and phantom claims are both reported', () => {
  assert.deepEqual(compareClaimed(['a', 'b'], ['b', 'c']), { unclaimed: ['c'], phantom: ['a'] });
  assert.deepEqual(compareClaimed(['a'], ['a']), { unclaimed: [], phantom: [] });
});

test('test path detection covers the repo conventions', () => {
  for (const p of [
    'src/a.test.ts',
    'x/y.spec.tsx',
    'scripts/__tests__/z.test.mjs',
    'tests/security/s.ts',
    'e2e/real-http.spec.ts',
  ]) {
    assert.ok(isTestPath(p), p);
  }
  for (const p of ['src/a.ts', 'shared/protocol/test-utils-not.ts']) assert.ok(!isTestPath(p), p);
});

test('red-first: only a test-runner failure counts as red', () => {
  assert.equal(
    classifyRedRun({ status: 1, output: ' FAIL  src/a.test.ts\n  × adds\n Tests  1 failed' }),
    null
  );
  assert.equal(classifyRedRun({ status: 1, output: 'not ok 1 - adds\n# fail 1' }), null);
  assert.equal(
    classifyRedRun({
      status: 1,
      output: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '../x.mjs'\n# fail 1",
    }),
    null
  );
  assert.match(classifyRedRun({ status: 0, output: 'Tests 3 passed' }), /PASSED/);
  assert.match(classifyRedRun({ status: null, output: '' }), /timed out|killed/);
  assert.match(
    classifyRedRun({ status: 127, output: 'sh: vitset: command not found' }),
    /not a test failure/
  );
  assert.match(
    classifyRedRun({ status: 1, output: 'npm error Missing script: "tset"' }),
    /not a test failure/
  );
  assert.match(
    classifyRedRun({ status: 1, output: 'something odd happened' }),
    /no test-runner failure/
  );
});
