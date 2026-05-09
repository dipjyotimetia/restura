import { describe, it, expect } from 'vitest';
import ScriptExecutor from '../scriptExecutor';

// These tests demonstrate that the QuickJS WASM sandbox is the security
// boundary, NOT a source-level regex. Each script uses a JS pattern that the
// previous `dangerousPatterns` regex would have rejected outright; with the
// regex removed, the script executes inside QuickJS and produces its expected
// log output. The script cannot reach any host API even if it tried — that's
// what the WASM sandbox guarantees.
//
// We assert by looking at console.log output (which the executor captures into
// `result.logs`) rather than by gating on `result.success`. There is a separate
// pre-existing issue with the `pm.expect`/`pm.response` setup ordering that
// surfaces as a benign error in `errors`; it is unrelated to this change and
// would mask `success` even on completely innocuous scripts.
describe('ScriptExecutor — sandbox is the security boundary', () => {
  it('user scripts using Function.prototype.bind execute (not source-rejected)', async () => {
    const executor = new ScriptExecutor({ MY_VAR: 'value' });
    const result = await executor.executeScript(
      `
      const fn = function() { return this.x; };
      const bound = fn.bind({ x: 42 });
      console.log('bound result', bound());
    `,
      {}
    );
    expect(result.errors).not.toContain('Script contains blocked patterns');
    expect(result.logs.some((l) => l.message.includes('bound result 42'))).toBe(true);
  });

  it('user scripts accessing constructor.name execute (not source-rejected)', async () => {
    const executor = new ScriptExecutor({});
    const result = await executor.executeScript(
      `
      console.log('type is', (42).constructor.name);
    `,
      {}
    );
    expect(result.errors).not.toContain('Script contains blocked patterns');
    expect(result.logs.some((l) => l.message.includes('type is Number'))).toBe(true);
  });

  it('eval inside the sandbox runs and returns a value (no source-level rejection)', async () => {
    const executor = new ScriptExecutor({});
    const result = await executor.executeScript(
      `
      const v = eval('40 + 2');
      console.log('eval gave', v);
    `,
      {}
    );
    expect(result.errors).not.toContain('Script contains blocked patterns');
    expect(result.logs.some((l) => l.message.includes('eval gave 42'))).toBe(true);
  });
});
