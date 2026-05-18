import { describe, it, expect } from 'vitest';
import {
  evalScriptValue,
  evalScriptBoolean,
  evalScriptForVariables,
} from '../scriptHelpers';

describe('evalScriptBoolean (precondition bug fix)', () => {
  it('returns true for "return true"', async () => {
    const ok = await evalScriptBoolean('return true;', { variables: {} });
    expect(ok).toBe(true);
  });

  it('returns false for "return false" (REGRESSION: legacy returned true)', async () => {
    // The legacy evaluatePrecondition checked result.success (= "no error
    // thrown") and returned `true` for any script that didn't throw —
    // including ones that explicitly returned false. This test guards
    // the fix that reads the actual return value.
    const ok = await evalScriptBoolean('return false;', { variables: {} });
    expect(ok).toBe(false);
  });

  it('returns false for "return 0"', async () => {
    const ok = await evalScriptBoolean('return 0;', { variables: {} });
    expect(ok).toBe(false);
  });

  it('returns true for "return 1"', async () => {
    const ok = await evalScriptBoolean('return 1;', { variables: {} });
    expect(ok).toBe(true);
  });

  it('returns false when the script throws', async () => {
    const ok = await evalScriptBoolean(
      'throw new Error("nope");',
      { variables: {} }
    );
    expect(ok).toBe(false);
  });

  it('returns false for an empty script', async () => {
    const ok = await evalScriptBoolean('   ', { variables: {} });
    expect(ok).toBe(false);
  });

  it('can read variables via pm.variables.get', async () => {
    const ok = await evalScriptBoolean(
      'return pm.variables.get("flag") === "yes";',
      { variables: { flag: 'yes' } }
    );
    expect(ok).toBe(true);
  });

  it('can inspect a response object', async () => {
    const ok = await evalScriptBoolean('return response.status === 201;', {
      variables: {},
      response: {
        status: 201,
        statusText: 'Created',
        headers: {},
        body: null,
        time: 10,
        size: 0,
      },
    });
    expect(ok).toBe(true);
  });
}, 30000);

describe('evalScriptValue', () => {
  it('returns the raw JSON-serialisable value', async () => {
    const result = await evalScriptValue('return { x: 1, y: "two" };', {
      variables: {},
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ x: 1, y: 'two' });
  });

  it('reports thrown errors structurally', async () => {
    const result = await evalScriptValue('throw new Error("boom");', {
      variables: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('boom');
  });

  it('rejects an empty script', async () => {
    const result = await evalScriptValue('', { variables: {} });
    expect(result.ok).toBe(false);
  });
}, 30000);

describe('evalScriptForVariables', () => {
  it('returns the variables map mutated by pm.variables.set', async () => {
    const result = await evalScriptForVariables(
      'pm.variables.set("greeted", "hello");',
      { variables: { initial: 'x' } }
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.variables.greeted).toBe('hello');
      expect(result.variables.initial).toBe('x');
    }
  });

  it('strips the internal sentinel key from the returned variables', async () => {
    const result = await evalScriptForVariables(
      'pm.variables.set("ok", "1");',
      { variables: {} }
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.variables).not.toHaveProperty('__restura_script_result');
    }
  });

  it('reports failure when the script throws', async () => {
    const result = await evalScriptForVariables('throw new Error("x");', {
      variables: {},
    });
    expect(result.ok).toBe(false);
  });
}, 30000);
