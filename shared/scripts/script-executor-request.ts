import type { QuickJSContext } from 'quickjs-emscripten';
import type { ScriptContext } from './script-executor-types';
import { makeJSValue } from './script-executor-values';

/**
 * Postman HeaderList methods, installed non-enumerable on the plain header map
 * so `rs.request.headers['X']` and `JSON.stringify` keep seeing only the
 * headers. Names match case-insensitively; a map holds one value per name, so
 * `add` of an existing name replaces it (Postman would send both).
 */
const HEADER_LIST_METHODS = `(function (h) {
  function find(key) {
    var lk = String(key).toLowerCase();
    for (var k in h) {
      if (Object.prototype.hasOwnProperty.call(h, k) && k.toLowerCase() === lk) return k;
    }
    return undefined;
  }
  function entry(header, value) {
    if (typeof header === 'string' && value === undefined) {
      var i = header.indexOf(':');
      return i === -1 ? { key: header.trim(), value: '' }
        : { key: header.slice(0, i).trim(), value: header.slice(i + 1).trim() };
    }
    if (header && typeof header === 'object') {
      return { key: String(header.key), value: header.value == null ? '' : String(header.value) };
    }
    return { key: String(header), value: value == null ? '' : String(value) };
  }
  function put(header, value) {
    var e = entry(header, value);
    if (!e.key) return;
    var existing = find(e.key);
    if (existing !== undefined && existing !== e.key) delete h[existing];
    h[existing !== undefined ? existing : e.key] = e.value;
  }
  var methods = {
    add: put,
    upsert: put,
    remove: function (key) {
      var lk = String(typeof key === 'object' && key ? key.key : key).toLowerCase();
      for (var k in h) {
        if (Object.prototype.hasOwnProperty.call(h, k) && k.toLowerCase() === lk) delete h[k];
      }
    },
    get: function (key) {
      var k = find(key);
      return k === undefined ? undefined : h[k];
    },
    has: function (key, value) {
      var k = find(key);
      return k !== undefined && (value === undefined || h[k] === value);
    },
    all: function () {
      return Object.keys(h).map(function (k) { return { key: k, value: h[k] }; });
    },
    each: function (fn) { methods.all().forEach(fn); },
    toObject: function () {
      var out = {};
      Object.keys(h).forEach(function (k) { out[k] = h[k]; });
      return out;
    },
    count: function () { return Object.keys(h).length; },
  };
  Object.keys(methods).forEach(function (name) {
    Object.defineProperty(h, name, { value: methods[name], enumerable: false, configurable: true, writable: true });
  });
})`;

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
      if (r && r.headers && typeof r.headers === 'object') ${HEADER_LIST_METHODS}(r.headers);
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

/**
 * Read `request.headers` back out of the sandbox after a pre-request script.
 * Not for gRPC (its headers are the metadata, read by `readRequestMetadata`).
 * Returns `undefined` unless the script changed them, so callers only rewrite
 * the outgoing request on a real edit.
 */
export function readRequestHeaders(
  vm: QuickJSContext,
  request: ScriptContext['request'] | undefined
): Record<string, string> | undefined {
  if (!request || request.metadata) return undefined;
  const r = vm.evalCode(
    'JSON.stringify(globalThis.request ? globalThis.request.headers : null) || "null"'
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
    if (key === '__proto__' || !key) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = String(value);
    }
  }
  const initial = request.headers ?? {};
  const initialKeys = Object.keys(initial);
  const unchanged =
    initialKeys.length === Object.keys(out).length &&
    initialKeys.every((key) => out[key] === initial[key]);
  return unchanged ? undefined : out;
}

interface HeaderRow {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}

/**
 * Fold a pre-request script's header edits onto the request's header rows.
 * `before` is the map the script was given and `after` the map it left, so a
 * header the script did not touch keeps its row (and its `{{var}}` template).
 * A removed header's enabled rows are disabled, a changed one takes the new
 * value, and a new one is appended.
 */
export function applyScriptHeaderEdits<T extends HeaderRow>(
  rows: readonly T[],
  before: Record<string, string>,
  after: Record<string, string>,
  newId: () => string
): T[] {
  const next = rows.map((row) => {
    if (!row.enabled) return row;
    if (Object.hasOwn(before, row.key) && !Object.hasOwn(after, row.key)) {
      return { ...row, enabled: false };
    }
    if (Object.hasOwn(after, row.key) && after[row.key] !== before[row.key]) {
      return { ...row, value: after[row.key] as string };
    }
    return row;
  });
  for (const [key, value] of Object.entries(after)) {
    if (Object.hasOwn(before, key)) continue;
    if (next.some((row) => row.enabled && row.key === key)) continue;
    next.push({ id: newId(), key, value, enabled: true } as T);
  }
  return next;
}
