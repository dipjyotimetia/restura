import type { QuickJSContext } from 'quickjs-emscripten';
import type { ScriptContext } from './script-executor-types';
import { makeJSValue } from './script-executor-values';

/**
 * Bind the per-eval `request` global. `rs.request` / `pm.request` read the
 * same object. When the protocol supplied gRPC metadata, `request.headers`
 * becomes a live alias of `request.metadata` so either spelling edits the
 * outgoing metadata (#910).
 */
export function bindRequestGlobal(
  vm: QuickJSContext,
  request: NonNullable<ScriptContext['request']>
): void {
  const handle = makeJSValue(vm, request);
  vm.setProp(vm.global, 'request', handle);
  handle.dispose();
  const alias = vm.evalCode(
    `(function () {
      var r = globalThis.request;
      pm.request = r;
      if (r && r.metadata && typeof r.metadata === 'object') {
        Object.defineProperty(r, 'headers', {
          get: function () { return r.metadata; },
          set: function (v) { r.metadata = v; },
          enumerable: true,
          configurable: true
        });
      }
    })();`
  );
  if (alias.error) alias.error.dispose();
  else alias.value.dispose();
}

/**
 * Read `request.metadata` back out of the sandbox after a script. Only applies
 * when the bound request carried metadata (gRPC). Only plain-object maps are
 * accepted; scalar values are coerced to strings and anything else dropped.
 * Returns `undefined` when the script left the metadata unchanged or replaced
 * it with a non-object, so callers only rewrite the outgoing request on a real
 * edit (#910).
 */
export function readRequestMetadata(
  vm: QuickJSContext,
  request: ScriptContext['request'] | undefined
): Record<string, string> | undefined {
  const initial = request?.metadata;
  if (!initial) return undefined;
  const r = vm.evalCode(
    'JSON.stringify(globalThis.request ? globalThis.request.metadata : null) || "null"'
  );
  if (r.error) {
    r.error.dispose();
    return undefined;
  }
  const raw = vm.dump(r.value);
  r.value.dispose();
  let parsed: unknown;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : null;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key === '__proto__') continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = String(value);
    }
  }
  const initialKeys = Object.keys(initial);
  const unchanged =
    initialKeys.length === Object.keys(out).length &&
    initialKeys.every((key) => out[key] === initial[key]);
  return unchanged ? undefined : out;
}
