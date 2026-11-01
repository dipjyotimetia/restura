import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assignShards,
  DEFAULT_SECONDS,
  listSpecs,
  parseShardArg,
  SPEC_SECONDS,
} from '../e2e-shard.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const specs = listSpecs(path.join(root, 'e2e'));

test('the extension-capture spec stays out of the web shards', () => {
  assert.ok(specs.length > 0);
  assert.ok(!specs.includes('extension-capture.spec.ts'));
});

test('every spec lands in exactly one shard', () => {
  for (const total of [1, 2, 3, 4, 5]) {
    const shards = assignShards(specs, total);
    assert.equal(shards.length, total);
    assert.deepEqual(shards.flat().sort(), [...specs].sort());
  }
});

test('assignment is deterministic', () => {
  assert.deepEqual(assignShards(specs, 4), assignShards([...specs].reverse(), 4));
});

test('the duration table has no stale or missing specs', () => {
  assert.deepEqual(Object.keys(SPEC_SECONDS).sort(), [...specs].sort());
});

test('four shards are balanced within 25% of the ideal', () => {
  const load = (f) => SPEC_SECONDS[f] ?? DEFAULT_SECONDS;
  const loads = assignShards(specs, 4).map((files) => files.reduce((s, f) => s + load(f), 0));
  const ideal = loads.reduce((a, b) => a + b, 0) / 4;
  assert.ok(Math.max(...loads) <= ideal * 1.25, `loads ${loads.join(', ')} vs ideal ${ideal}`);
});

test('an unknown new spec is still assigned once', () => {
  const shards = assignShards([...specs, 'brand-new.spec.ts'], 4);
  assert.equal(shards.flat().filter((f) => f === 'brand-new.spec.ts').length, 1);
});

test('shard argument is validated', () => {
  assert.deepEqual(parseShardArg('3/4'), { current: 3, total: 4 });
  for (const bad of ['', '0/4', '5/4', 'a/b', '3', undefined]) {
    assert.throws(() => parseShardArg(bad), /expected|out of range/);
  }
});

test('the CLI prints e2e/-prefixed paths and fails on a bad shard', () => {
  const script = path.join(root, 'scripts', 'e2e-shard.mjs');
  const ok = spawnSync(process.execPath, [script, '1/4'], { encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout.trim(), /^(e2e\/[\w-]+\.spec\.ts)( e2e\/[\w-]+\.spec\.ts)*$/);
  const bad = spawnSync(process.execPath, [script, '9/4'], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
});
