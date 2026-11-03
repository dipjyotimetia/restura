import { afterEach, describe, expect, it, vi } from 'vitest';
import ScriptExecutor from './script-executor';

describe('ScriptExecutor reuse across evals', () => {
  afterEach(() => vi.useRealTimers());

  it('does not apply a finished eval’s deadline to the next eval’s trusted setup', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const executor = new ScriptExecutor();
    await executor.initialize();
    executor.__setCeilingsForTest(50, 50);
    try {
      // Frame 1 installs a `pm.info` setter whose body runs enough bytecode to
      // reach QuickJS's interrupt poll. The next eval's trusted
      // `pm.info = {...}` binding invokes it before the user script starts.
      const first = await executor.eval(
        `Object.defineProperty(pm, 'info', {
          configurable: true,
          get: function () { return {}; },
          set: function (v) {
            for (var i = 0; i < 200000; i++) {}
            pm.environment.set('boundInfo', v.requestName);
          }
        });`
      );
      expect(first.errors).toEqual([]);

      // The connection idles longer than the ceiling before the next frame.
      vi.setSystemTime(Date.now() + 1_000);

      const second = await executor.eval(`pm.environment.set('frame', '2');`, {
        info: { requestName: 'frame-2' },
      });
      expect(second.errors).toEqual([]);
      expect(second.variables.boundInfo).toBe('frame-2');
    } finally {
      executor.dispose();
    }
  });

  // A hostile frame-1 script (e.g. from an imported collection) hooks an
  // object the next eval's trusted setup touches. `busy(2s)` stays finite so
  // an unbounded setup phase fails this test instead of hanging the run.
  const busy = 'var end = Date.now() + 2000; while (Date.now() < end) {}';
  const timedOut = 'Script execution timed out after 50ms';
  it.each([
    ['a pm.info setter', `Object.defineProperty(pm, 'info', { set: function () { ${busy} } });`],
    [
      'a pm.execution getter',
      `Object.defineProperty(pm, 'execution', { get: function () { ${busy} return {}; } });`,
    ],
    [
      'a sentinel setter',
      `Object.defineProperty(globalThis, '__pm_execution_state__', { set: function () { ${busy} } });`,
    ],
  ])(
    'times out the next eval’s setup phase when %s loops',
    async (label, hook) => {
      const executor = new ScriptExecutor();
      await executor.initialize();
      executor.__setCeilingsForTest(50, 50);
      try {
        expect((await executor.eval(hook)).errors).toEqual([]);
        const started = Date.now();
        const second = await executor.eval(`pm.environment.set('ran', 'yes');`, { info: {} });
        expect(Date.now() - started).toBeLessThan(1_500);
        expect(second.success).toBe(false);
        expect(second.errors).toContain(timedOut);
        expect(second.variables.ran).toBeUndefined();
        // The empty-script path still resets the sentinel, under the same bound.
        const empty = await executor.eval('   ');
        if (label === 'a sentinel setter') expect(empty.errors).toContain(timedOut);
        else expect(empty.errors).toEqual([]);
      } finally {
        executor.dispose();
      }
    },
    20_000
  );

  it('returns a timeout instead of hanging on an infinite-loop getter', async () => {
    const executor = new ScriptExecutor();
    await executor.initialize();
    executor.__setCeilingsForTest(50, 50);
    try {
      await executor.eval(
        `Object.defineProperty(pm, 'execution', { get: function () { while (true) {} } });`
      );
      const second = await executor.eval(`pm.environment.set('ran', 'yes');`);
      expect(second.errors).toContain(timedOut);
      expect(second.variables.ran).toBeUndefined();
    } finally {
      executor.dispose();
    }
  }, 20_000);

  // A host promise that settles after its eval timed out must not run the
  // user's queued reaction jobs outside any deadline. `spin` stays finite (2s)
  // so a regression fails this test instead of hanging the run; in production
  // it is `while (true) {}`.
  it('never drains user jobs without a deadline when a host promise settles late', async () => {
    const settle: Array<() => void> = [];
    const executor = new ScriptExecutor({
      host: {
        sendRequest: () =>
          new Promise((_resolve, reject) => settle.push(() => reject(new Error('late')))),
      },
    });
    await executor.initialize();
    executor.__setCeilingsForTest(50, 50);
    try {
      const spin = `var end = Date.now() + 2000; while (Date.now() < end) {} pm.environment.set('late', 'ran');`;
      // The timeout rejects request a; its handler starts request b, which
      // outlives the eval and is rejected later by the host.
      const first = await executor.eval(
        `pm.sendRequest('https://a.example/').catch(function () {
           pm.sendRequest('https://b.example/').catch(function () { ${spin} });
         });`
      );
      expect(first.errors).toContain(timedOut);

      const started = Date.now();
      for (const s of settle) s();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(executor.getVariables().late).toBeUndefined();
    } finally {
      executor.dispose();
    }
  }, 20_000);
});
