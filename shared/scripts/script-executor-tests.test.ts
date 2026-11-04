import { describe, expect, it } from 'vitest';
import { PmTestRecorder } from './script-executor-tests';

type Entry = { name: string; passed: boolean; error?: string };

function recorder() {
  let tests: Entry[] = [];
  const logs: Array<[string, string]> = [];
  const rec = new PmTestRecorder(
    () => tests,
    (type, message) => logs.push([type, message])
  );
  return {
    rec,
    logs,
    get tests() {
      return tests;
    },
    replaceTests(next: Entry[]) {
      tests = next;
    },
  };
}

describe('PmTestRecorder', () => {
  it('keeps call order: a test reserved first reports first even when it settles last', () => {
    const r = recorder();
    const slow = r.rec.reserve('slow');
    const fast = r.rec.reserve('fast');
    r.rec.settle(fast, true);
    r.rec.settle(slow, false, 'timed out');
    expect(r.tests).toEqual([
      { name: 'slow', passed: false, error: 'timed out' },
      { name: 'fast', passed: true },
    ]);
    expect(r.logs).toEqual([
      ['info', '✓ fast'],
      ['error', '✗ slow: timed out'],
    ]);
  });

  it('a failure without a message reads "Test failed"', () => {
    const r = recorder();
    r.rec.settle(r.rec.reserve('t'), false, '');
    expect(r.tests[0]).toEqual({ name: 't', passed: false, error: 'Test failed' });
  });

  it('ignores a second settle of the same slot and a slot that was never reserved', () => {
    const r = recorder();
    const slot = r.rec.reserve('once');
    r.rec.settle(slot, false, 'first');
    r.rec.settle(slot, true);
    r.rec.settle(99, true);
    expect(r.tests).toEqual([{ name: 'once', passed: false, error: 'first' }]);
    expect(r.logs).toHaveLength(1);
  });

  it('fails every still-pending test, and reset forgets pending slots', () => {
    const r = recorder();
    r.rec.reserve('a');
    r.rec.settle(r.rec.reserve('b'), true);
    r.rec.failPending('script ended');
    expect(r.tests.map((t) => [t.name, t.passed, t.error])).toEqual([
      ['a', false, 'script ended'],
      ['b', true, undefined],
    ]);

    const slot = r.rec.reserve('c');
    r.rec.reset();
    r.rec.settle(slot, true);
    expect(r.tests[2]).toEqual({ name: 'c', passed: false });
  });

  it('a pending slot whose test list was replaced is dropped quietly', () => {
    const r = recorder();
    const slot = r.rec.reserve('old');
    r.replaceTests([]);
    r.rec.settle(slot, true);
    expect(r.tests).toEqual([]);
    expect(r.logs).toEqual([]);
  });
});
