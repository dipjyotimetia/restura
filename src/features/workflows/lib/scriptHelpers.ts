/**
 * Run a user QuickJS script and read its return value.
 *
 * Fixes a real bug in the legacy `evaluatePrecondition`
 * (workflowExecutor.ts:281-309): that function checked `result.success`
 * (which means "no thrown errors") and returned `true` whenever the
 * script ran without throwing — regardless of what the script actually
 * returned. A precondition `return false` produced `true`.
 *
 * The fix exploits the only return channel `ScriptExecutor` exposes:
 * `result.variables`. We wrap the user script in an IIFE that captures
 * its return value, JSON-encodes it, and writes it to a sentinel
 * variable via `pm.variables.set`. The host then reads the sentinel
 * back from `result.variables` and parses it. Exceptions inside the
 * user script are caught and reported through the same sentinel so a
 * thrown script returns a structured error instead of silently
 * succeeding with no value.
 */
import ScriptExecutor from '@/features/scripts/lib/scriptExecutor';
import { useGlobalsStore } from '@/store/useGlobalsStore';

const RESULT_KEY = '__restura_script_result';
const COMPLETED_KEY = '__restura_script_completed';
const ERROR_MARKER = '__restura_script_error';

/**
 * Internal: ScriptExecutor logs a noisy "Failed to setup pm API" error in
 * its `errors` array even when the user's script ran fine, because its pm
 * setup chain references `pm` before it's attached to the global object.
 * That polluted error makes `result.success` unreliable for our purposes.
 * The completion-sentinel pattern lets us tell "user script ran to
 * completion" apart from "user script threw / failed to evaluate"
 * independently of `result.success`.
 */
const PM_SETUP_NOISE = /Failed to setup pm API/;
function hasOnlySetupNoise(errors: string[]): boolean {
  return errors.length > 0 && errors.every((e) => PM_SETUP_NOISE.test(e));
}

export interface ScriptEvalContext {
  variables: Record<string, string>;
  request?: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: unknown;
  };
  response?: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: unknown;
    time: number;
    size: number;
  };
}

export type EvalSuccess = { ok: true; value: unknown };
export type EvalFailure = { ok: false; error: string };
export type EvalResult = EvalSuccess | EvalFailure;

export async function evalScriptValue(script: string, ctx: ScriptEvalContext): Promise<EvalResult> {
  const trimmed = script?.trim?.();
  if (!trimmed) {
    return { ok: false, error: 'Script is empty' };
  }

  const callerVars = { ...ctx.variables };
  // Don't let stale sentinels from a previous run leak in.
  delete callerVars[RESULT_KEY];
  delete callerVars[COMPLETED_KEY];

  const wrapped = `
    (function() {
      try {
        var __restura_value = (function() {
          ${script}
        })();
        var __serialised = __restura_value === undefined ? null : __restura_value;
        pm.variables.set(${JSON.stringify(RESULT_KEY)}, JSON.stringify(__serialised));
      } catch (e) {
        var __msg = (e && e.message) ? e.message : String(e);
        pm.variables.set(${JSON.stringify(RESULT_KEY)}, JSON.stringify({ ${JSON.stringify(ERROR_MARKER)}: __msg }));
      }
    })();
  `;

  const executor = new ScriptExecutor({
    envVars: callerVars,
    globalVars: useGlobalsStore.getState().vars,
  });
  const scriptCtx: Parameters<ScriptExecutor['executeScript']>[1] = {};
  if (ctx.request) scriptCtx.request = ctx.request;
  if (ctx.response) scriptCtx.response = ctx.response;

  const result = await executor.executeScript(wrapped, scriptCtx);

  // The sentinel is set whether the user script returned or threw, so
  // it's the authoritative completion signal — independent of the noisy
  // pm-API setup errors that ScriptExecutor logs unconditionally.
  const raw = result.variables[RESULT_KEY];
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        ERROR_MARKER in (parsed as Record<string, unknown>)
      ) {
        return {
          ok: false,
          error: String((parsed as Record<string, unknown>)[ERROR_MARKER]),
        };
      }
      return { ok: true, value: parsed };
    } catch {
      return { ok: false, error: 'Script result was not valid JSON' };
    }
  }

  if (!result.success && !hasOnlySetupNoise(result.errors)) {
    return { ok: false, error: result.errors.join('; ') || 'Script failed' };
  }
  return { ok: false, error: 'Script did not produce a return value' };
}

/**
 * Evaluate a script and coerce its result to boolean.
 *
 * Used for condition / precondition nodes. A script that fails (throws,
 * times out, doesn't return a value) returns `false` so a broken
 * precondition skips rather than crashing the whole workflow — matches
 * the legacy behaviour. The DIFFERENCE from the legacy: a script that
 * successfully returns `false` now actually returns `false` instead of
 * being misread as `true`.
 */
export async function evalScriptBoolean(script: string, ctx: ScriptEvalContext): Promise<boolean> {
  const result = await evalScriptValue(script, ctx);
  if (!result.ok) return false;
  return Boolean(result.value);
}

/**
 * Pooled evaluator — holds a live `ScriptExecutor` session so the
 * QuickJS runtime + pm.* setup are paid once instead of per call. Used
 * by the DAG executor's `consumeWithPolicy` for `eventMatch` predicates
 * on high-frequency streams.
 */
export interface PooledEvaluator {
  /** Evaluate against an optional per-call variable set. */
  evaluate(perCallVars?: Record<string, string>): Promise<EvalResult>;
  /** Dispose the underlying QuickJS runtime. Idempotent. */
  dispose(): void;
}

const noopEvaluator: PooledEvaluator = {
  evaluate: async () => ({ ok: false, error: 'Script is empty' }),
  dispose: () => undefined,
};

export async function createPooledScriptEvaluator(
  script: string,
  baseCtx: ScriptEvalContext
): Promise<PooledEvaluator> {
  const trimmed = script?.trim?.();
  if (!trimmed) return noopEvaluator;

  const executor = new ScriptExecutor({
    envVars: { ...baseCtx.variables },
    globalVars: useGlobalsStore.getState().vars,
  });
  await executor.initialize();

  // The sentinel-wrapped script is composed once and reused across calls
  // — the QuickJS runtime + pm.* bring-up happens during `initialize()`
  // and is not repeated per `evaluate()`.
  const wrapped = `
    (function() {
      try {
        var __restura_value = (function() {
          ${script}
        })();
        var __serialised = __restura_value === undefined ? null : __restura_value;
        pm.variables.set(${JSON.stringify(RESULT_KEY)}, JSON.stringify(__serialised));
      } catch (e) {
        var __msg = (e && e.message) ? e.message : String(e);
        pm.variables.set(${JSON.stringify(RESULT_KEY)}, JSON.stringify({ ${JSON.stringify(ERROR_MARKER)}: __msg }));
      }
    })();
  `;

  let disposed = false;
  return {
    async evaluate(perCallVars) {
      if (disposed) return { ok: false, error: 'Evaluator disposed' };
      // Clear stale sentinels left by the previous call.
      executor.setVariable(RESULT_KEY, '');
      executor.setVariable(COMPLETED_KEY, '');
      if (perCallVars) {
        for (const [k, v] of Object.entries(perCallVars)) {
          executor.setVariable(k, v);
        }
      }
      const scriptCtx: Parameters<typeof executor.eval>[1] = {};
      if (baseCtx.request) scriptCtx.request = baseCtx.request;
      if (baseCtx.response) scriptCtx.response = baseCtx.response;
      const result = await executor.eval(wrapped, scriptCtx);
      const raw = result.variables[RESULT_KEY];
      if (typeof raw === 'string' && raw !== '') {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (
            parsed !== null &&
            typeof parsed === 'object' &&
            ERROR_MARKER in (parsed as Record<string, unknown>)
          ) {
            return {
              ok: false,
              error: String((parsed as Record<string, unknown>)[ERROR_MARKER]),
            };
          }
          return { ok: true, value: parsed };
        } catch {
          return { ok: false, error: 'Script result was not valid JSON' };
        }
      }
      if (!result.success && !hasOnlySetupNoise(result.errors)) {
        return {
          ok: false,
          error: result.errors.join('; ') || 'Script failed',
        };
      }
      return { ok: false, error: 'Script did not produce a return value' };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      executor.dispose();
    },
  };
}

/**
 * Run a script for its side effects on variables, returning the merged
 * map. Used by `setVariable` and `transform` nodes which want
 * `pm.variables.set(...)` calls to propagate. The result sentinel is
 * stripped from the returned map.
 */
export async function evalScriptForVariables(
  script: string,
  ctx: ScriptEvalContext
): Promise<{ ok: true; variables: Record<string, string> } | EvalFailure> {
  const trimmed = script?.trim?.();
  if (!trimmed) {
    return { ok: true, variables: { ...ctx.variables } };
  }

  const callerVars = { ...ctx.variables };
  delete callerVars[RESULT_KEY];
  delete callerVars[COMPLETED_KEY];

  // Wrap so we can tell "script ran to completion" apart from
  // "ScriptExecutor failed during pm-API setup before our code ran." The
  // completion sentinel is the authoritative signal — result.success
  // includes pm-setup noise we don't care about.
  const wrapped = `
    (function() {
      try {
        ${script}
        pm.variables.set(${JSON.stringify(COMPLETED_KEY)}, '1');
      } catch (e) {
        var __msg = (e && e.message) ? e.message : String(e);
        pm.variables.set(${JSON.stringify(COMPLETED_KEY)}, '0');
        pm.variables.set(${JSON.stringify(RESULT_KEY)}, JSON.stringify({ ${JSON.stringify(ERROR_MARKER)}: __msg }));
      }
    })();
  `;

  const executor = new ScriptExecutor({
    envVars: callerVars,
    globalVars: useGlobalsStore.getState().vars,
  });
  const scriptCtx: Parameters<ScriptExecutor['executeScript']>[1] = {};
  if (ctx.request) scriptCtx.request = ctx.request;
  if (ctx.response) scriptCtx.response = ctx.response;

  const result = await executor.executeScript(wrapped, scriptCtx);
  const completed = result.variables[COMPLETED_KEY];

  if (completed === '1') {
    const out = { ...result.variables };
    delete out[RESULT_KEY];
    delete out[COMPLETED_KEY];
    return { ok: true, variables: out };
  }

  if (completed === '0') {
    const errPayload = result.variables[RESULT_KEY];
    if (typeof errPayload === 'string') {
      try {
        const parsed: unknown = JSON.parse(errPayload);
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          ERROR_MARKER in (parsed as Record<string, unknown>)
        ) {
          return {
            ok: false,
            error: String((parsed as Record<string, unknown>)[ERROR_MARKER]),
          };
        }
      } catch {
        // fall through
      }
    }
    return { ok: false, error: 'Script threw an error' };
  }

  return {
    ok: false,
    error: result.errors.join('; ') || 'Script failed before completion',
  };
}
