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
});
