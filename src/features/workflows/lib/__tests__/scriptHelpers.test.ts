import { describe, it, expect } from 'vitest';
import {
  evalScriptValue,
  evalScriptBoolean,
  evalScriptForVariables,
  createPooledScriptEvaluator,
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

describe('createPooledScriptEvaluator', () => {
  it('evaluates against many distinct per-call variable sets', async () => {
    const evaluator = await createPooledScriptEvaluator(
      'return Number(pm.variables.get("event"));',
      { variables: {} }
    );
    try {
      // Run 20 sequential evaluations — they all share one QuickJS runtime.
      // If the runtime were being recreated per call, the loop would still
      // succeed, but this asserts correctness across many calls.
      for (let i = 0; i < 20; i++) {
        const r = await evaluator.evaluate({ event: String(i) });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toBe(i);
      }
    } finally {
      evaluator.dispose();
    }
  });

  it('uses noticeably less wall time than per-call evalScriptValue', async () => {
    // 30 sequential evaluations. The pooled path skips the ~30 ms QuickJS
    // bring-up per call. We assert the pool is at least 2× faster than the
    // one-shot path — wide enough margin to avoid flakes.
    const script = 'return Number(pm.variables.get("event")) > 5;';

    const oneShotStart = Date.now();
    for (let i = 0; i < 30; i++) {
      await evalScriptValue(script, { variables: { event: String(i) } });
    }
    const oneShotMs = Date.now() - oneShotStart;

    const evaluator = await createPooledScriptEvaluator(script, { variables: {} });
    const pooledStart = Date.now();
    try {
      for (let i = 0; i < 30; i++) {
        await evaluator.evaluate({ event: String(i) });
      }
    } finally {
      evaluator.dispose();
    }
    const pooledMs = Date.now() - pooledStart;

    expect(pooledMs).toBeLessThan(oneShotMs / 2);
  });

  it('dispose makes subsequent evaluate calls return a clear error', async () => {
    const evaluator = await createPooledScriptEvaluator('return 1;', {
      variables: {},
    });
    evaluator.dispose();
    const r = await evaluator.evaluate();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/disposed/i);
  });

  it('returns a no-op evaluator for empty scripts', async () => {
    const evaluator = await createPooledScriptEvaluator('   ', { variables: {} });
    const r = await evaluator.evaluate();
    expect(r.ok).toBe(false);
  });
}, 60000);
