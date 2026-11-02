import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareToBaseline, countByRule } from '../biome-ratchet.mjs';

test('countByRule ignores errors and counts warnings and infos per rule', () => {
  const counts = countByRule([
    { category: 'lint/a', severity: 'warning' },
    { category: 'lint/a', severity: 'warning' },
    { category: 'lint/b', severity: 'info' },
    { category: 'lint/c', severity: 'error' },
  ]);
  assert.deepEqual(counts, { 'lint/a': 2, 'lint/b': 1 });
});

test('compareToBaseline flags a rule above its allowance', () => {
  const { regressions } = compareToBaseline({ 'lint/a': 3 }, { 'lint/a': 2 });
  assert.deepEqual(regressions, [{ rule: 'lint/a', current: 3, allowed: 2 }]);
});

test('compareToBaseline treats a rule missing from the baseline as allowance zero', () => {
  const { regressions } = compareToBaseline({ 'lint/new': 1 }, {});
  assert.deepEqual(regressions, [{ rule: 'lint/new', current: 1, allowed: 0 }]);
});

test('compareToBaseline reports a rule that dropped to zero as an improvement', () => {
  const { regressions, improvements } = compareToBaseline({}, { 'lint/a': 2 });
  assert.deepEqual(regressions, []);
  assert.deepEqual(improvements, [{ rule: 'lint/a', current: 0, allowed: 2 }]);
});
