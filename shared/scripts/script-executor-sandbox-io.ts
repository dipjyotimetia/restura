/**
 * QuickJS-side pieces of the script executor that need no executor state: the
 * `pm.sendRequest` Postman wrapper source, top-level-await wrapping, how a
 * script's completion promise is reported, and the sentinel read-backs.
 */
import type { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten';
import type { ScriptResult } from './script-executor-types';

/**
 * The Postman surface of `pm.sendRequest(request, [callback])` over the native
 * `pm.__sendRequestNative`. The response gets `json()`, `text()` and a
 * case-insensitive `headers.get()` / `has()` (non-enumerable, so the response
 * still serialises as before). With a callback, the host error goes to the
 * callback rather than rejecting the returned promise, and anything the
 * callback throws (or an async callback rejects with) is a script error.
 */
export const SEND_REQUEST_WRAPPER = `(function () {
  var nativeSend = pm.__sendRequestNative;
  var report = globalThis.__rs_reportScriptError;
  delete pm.__sendRequestNative;
  delete globalThis.__rs_reportScriptError;
  function describe(e) {
    if (e && typeof e === 'object' && 'message' in e) {
      return (e.name ? String(e.name) + ': ' : '') + String(e.message);
    }
    return String(e);
  }
  function hidden(target, name, fn) {
    Object.defineProperty(target, name, { value: fn, enumerable: false, configurable: true, writable: true });
  }
  function decorate(res) {
    if (!res || typeof res !== 'object') return res;
    var body = res.body;
    hidden(res, 'text', function () {
      if (body === undefined || body === null) return '';
      return typeof body === 'string' ? body : JSON.stringify(body);
    });
    hidden(res, 'json', function () {
      return typeof body === 'string' ? JSON.parse(body) : body;
    });
    var headers = res.headers && typeof res.headers === 'object' ? res.headers : {};
    function find(key) {
      var lk = String(key).toLowerCase();
      for (var k in headers) {
        if (Object.prototype.hasOwnProperty.call(headers, k) && k.toLowerCase() === lk) return headers[k];
      }
      return undefined;
    }
    hidden(headers, 'get', find);
    hidden(headers, 'has', function (key) { return find(key) !== undefined; });
    hidden(headers, 'toObject', function () {
      var out = {};
      for (var k in headers) if (Object.prototype.hasOwnProperty.call(headers, k)) out[k] = headers[k];
      return out;
    });
    return res;
  }
  function runCallback(callback, err, res) {
    try {
      var returned = callback(err, res);
      if (returned && typeof returned.then === 'function') {
        returned.then(undefined, function (e) {
          report('pm.sendRequest callback error: ' + describe(e));
        });
      }
    } catch (e) {
      report('pm.sendRequest callback error: ' + describe(e));
    }
  }
  pm.sendRequest = function (request, callback) {
    var promise = nativeSend(request).then(decorate);
    if (typeof callback !== 'function') return promise;
    return promise.then(
      function (res) { runCallback(callback, null, res); return res; },
      function (err) { runCallback(callback, err, null); return undefined; }
    );
  };
})();`;

/**
 * The source to evaluate. A script with a top-level `await` (a SyntaxError
 * in global code) runs as the body of an async function, opened on the
 * script's first line so line numbers stay the same; its `var` and function
 * declarations are then local to the script, which a one-shot run cannot
 * tell apart. Every other script, including one that does not compile at
 * all, is evaluated exactly as written.
 */
export function userScriptSource(
  vm: QuickJSContext,
  script: string
): { source: string; topLevelAwait: boolean } {
  if (!/\bawait\b/.test(script)) return { source: script, topLevelAwait: false };
  const asIs = vm.evalCode(script, 'user-script.js', { compileOnly: true });
  if (!asIs.error) {
    asIs.value.dispose();
    return { source: script, topLevelAwait: false };
  }
  asIs.error.dispose();
  // This is user-authored code by design; it is evaluated only in QuickJS,
  // which is the security boundary described in ADR-0015.
  const wrapped = `(async function () {${script}\n})()`;
  const probe = vm.evalCode(wrapped, 'user-script.js', { compileOnly: true });
  if (probe.error) {
    probe.error.dispose();
    return { source: script, topLevelAwait: false };
  }
  probe.value.dispose();
  return { source: wrapped, topLevelAwait: true };
}

/**
 * The error (if any) the script's completion promise ended with. A rejected top-level
 * await is a script error, as is a rejected promise the script left as its
 * last expression (an unhandled async IIFE); a top-level await that never
 * settled means the rest of the script never ran.
 *
 * A rejected promise the script dropped anywhere else is reported by the
 * in-sandbox tracker (rejection-tracker.ts), which skips this one.
 */
export function completionErrorMessage(
  vm: QuickJSContext,
  completion: { handle: QuickJSHandle; topLevelAwait: boolean }
): string | undefined {
  const state = vm.getPromiseState(completion.handle);
  if (state.type === 'rejected') {
    const message = describeQuickJsError(vm, state.error);
    state.error.dispose();
    return completion.topLevelAwait
      ? `Script execution error: ${message}`
      : `Unhandled promise rejection: ${message}`;
  }
  if (state.type === 'pending') {
    return completion.topLevelAwait
      ? 'Script execution error: a top-level await never settled, so the rest of the script did not run'
      : undefined;
  }
  if (!state.notAPromise) state.value.dispose();
  return undefined;
}

/** The same text a synchronous script error has always been reported with. */
export function describeQuickJsError(vm: QuickJSContext, handle: QuickJSHandle): string {
  const errorValue = vm.dump(handle);
  return typeof errorValue === 'string' ? errorValue : JSON.stringify(errorValue);
}

/** Read `__pm_execution_state__` back into the typed sentinel shape. */
export function readExecutionSentinel(vm: QuickJSContext): ScriptResult['execution'] | undefined {
  const out: ScriptResult['execution'] = {};
  const r = vm.evalCode('JSON.stringify(globalThis.__pm_execution_state__ || null)');
  if (r.error) {
    r.error.dispose();
    return undefined;
  }
  const raw = vm.dump(r.value);
  r.value.dispose();
  if (typeof raw !== 'string' || raw === 'null') return undefined;
  try {
    const parsed = JSON.parse(raw) as {
      nextRequest?: string | null | undefined;
      skipRequested?: boolean;
    };
    if (parsed && 'nextRequest' in parsed && parsed.nextRequest !== undefined) {
      out.nextRequest = parsed.nextRequest;
    }
    if (parsed && parsed.skipRequested === true) {
      out.skipRequested = true;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Read `__pm_visualization__` back into the typed sentinel shape. */
export function readVisualizationSentinel(
  vm: QuickJSContext
): ScriptResult['visualization'] | undefined {
  const r = vm.evalCode('JSON.stringify(globalThis.__pm_visualization__ || null)');
  if (r.error) {
    r.error.dispose();
    return undefined;
  }
  const raw = vm.dump(r.value);
  r.value.dispose();
  if (typeof raw !== 'string' || raw === 'null') return undefined;
  try {
    const parsed = JSON.parse(raw) as { template?: string; data?: unknown };
    if (parsed && typeof parsed.template === 'string') {
      return { template: parsed.template, data: parsed.data };
    }
    return undefined;
  } catch {
    return undefined;
  }
}
