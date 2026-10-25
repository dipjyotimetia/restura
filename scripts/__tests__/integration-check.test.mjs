import assert from 'node:assert/strict';
import test from 'node:test';
import { computeOverlap, formatTable, parseIntegrationArgs } from '../integration-check.mjs';

test('parses branches and options in any order', () => {
  assert.deepEqual(
    parseIntegrationArgs([
      'origin/a',
      '--base',
      'origin/dev',
      'b',
      '--e2e',
      '--keep',
      '--continue-on-conflict',
    ]),
    {
      branches: ['origin/a', 'b'],
      base: 'origin/dev',
      e2e: true,
      keep: true,
      continueOnConflict: true,
      fetch: true,
      gates: undefined,
    }
  );
  const defaults = parseIntegrationArgs([
    'x',
    '--base=origin/main',
    '--no-fetch',
    '--gates=lint,type-check',
  ]);
  assert.equal(defaults.base, 'origin/main');
  assert.equal(defaults.fetch, false);
  assert.deepEqual(defaults.gates, ['lint', 'type-check']);
});

test('rejects missing branches, bad --base and unknown options', () => {
  assert.throws(() => parseIntegrationArgs([]), /at least one branch/);
  assert.throws(() => parseIntegrationArgs(['a', '--base']), /--base needs a ref/);
  assert.throws(() => parseIntegrationArgs(['a', '--base', '--e2e']), /--base needs a ref/);
  assert.throws(() => parseIntegrationArgs(['a', '--push']), /Unknown option/);
});

test('reports only files touched by more than one branch, generated ones separately', () => {
  const { overlaps, generated, registries } = computeOverlap({
    a: ['src/a.ts', 'scripts/architecture.config.mts', 'package-lock.json', 'src/shared.ts'],
    b: [
      'src/b.ts',
      'scripts/architecture.config.mts',
      'package-lock.json',
      'src/shared.ts',
      'src/shared.ts',
    ],
    c: ['src/shared.ts', 'docs/CAPABILITY_MATRIX.md'],
  });
  assert.deepEqual(overlaps, [
    { file: 'scripts/architecture.config.mts', branches: ['a', 'b'] },
    { file: 'src/shared.ts', branches: ['a', 'b', 'c'] },
  ]);
  assert.deepEqual(generated, [{ file: 'package-lock.json', branches: ['a', 'b'] }]);
  assert.deepEqual([...registries], ['scripts/architecture.config.mts']);
});

test('formats an aligned table', () => {
  assert.equal(
    formatTable(
      ['step', 'result'],
      [
        ['lint', 'PASS'],
        ['test:coverage', 'FAIL'],
      ]
    ),
    [
      'step           result',
      '-------------  ------',
      'lint           PASS',
      'test:coverage  FAIL',
    ].join('\n')
  );
});
