// Scripting Sandbox for Pre-request and Test Scripts
// Provides a SECURE sandboxed environment using QuickJS for executing user scripts
// Security features: Memory limits, execution timeout, no filesystem/network access

import type { QuickJSContext, QuickJSHandle, QuickJSRuntime } from 'quickjs-emscripten';
import { getQuickJS } from 'quickjs-emscripten';
import { PM_EXPECT_BOOTSTRAP } from './pmExpect';
import { loadSandboxLibraries, buildRequireShimSource } from './sandboxLibraries';
import type { PmCookieAdapter, PmCookieRecord } from './pmCookieAdapter';
export type { PmCookieAdapter, PmCookieRecord };

export interface PmRequestInfo {
  requestName?: string;
  requestId?: string;
  iteration?: number;
  iterationCount?: number;
}

/**
 * Postman-compatible execution-location context bound onto `pm.execution.location`.
 * Populated by the collection runner; absent for one-off requests.
 */
export interface PmExecutionLocation {
  currentRequestName: string;
  folderPath: string[];
  collectionName: string;
}

/**
 * Host-side bridges injected at construction time. The executor stays
 * decoupled from `executeProxiedRequest` / `useCookieStore` / the vault IPC
 * so its module dependency graph remains tiny — callers in
 * `src/features/http/`, `src/features/grpc/`, and `cli/src/runner/` wire
 * the closures in per harness.
 */
export interface ScriptHostBridges {
  /**
   * Fire a sub-request from `pm.sendRequest`. Must route through the same
   * SSRF-guarded path as a top-level send (the renderer uses
   * `executeProxiedRequest`, the CLI uses `undiciFetcher`). Phase C wires
   * implementations; Phase B+below this is a no-op slot.
   */
  sendRequest?: (input: PmSendRequestInput) => Promise<PmSubResponse>;
  /**
   * Cookie jar adapter factory for `pm.cookies` (Phase C). The factory
   * receives the active request URL so `pm.cookies.get(name)` scopes its
   * read to the right domain+path. The renderer passes
   * `makeCookieAdapter` (backed by `useCookieStore`); the CLI passes a
   * file-jar variant or omits it.
   */
  cookies?: (currentUrl: string | undefined) => PmCookieAdapter;
  /** Vault key-value store for `pm.vault` (Phase D). */
  vault?: PmVaultAdapter;
}

/** Phase-C placeholder shapes — concretized when host bridges land. */
export interface PmSendRequestInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface PmSubResponse {
  code: number;
  status: string;
  headers: Record<string, string>;
  body: string;
  responseTime: number;
  responseSize: number;
}

export interface PmVaultAdapter {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  unset(key: string): Promise<void>;
}

/** Full constructor shape for `new ScriptExecutor({...})`. */
export interface ScriptExecutorOptions {
  envVars?: Record<string, string>;
  globalVars?: Record<string, string>;
  collectionVars?: Record<string, string>;
  iterationData?: Record<string, string>;
  info?: PmRequestInfo;
  location?: PmExecutionLocation;
  host?: ScriptHostBridges;
}

export interface ScriptContext {
  // Request/Response data
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

  // Environment variables
  environment: {
    get: (key: string) => string | undefined;
    set: (key: string, value: string) => void;
  };

  // Global variables
  globals: {
    get: (key: string) => string | undefined;
    set: (key: string, value: string) => void;
  };

  // Console logs
  console: {
    log: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
  };

  // Test assertions (for test scripts)
  pm: {
    test: (name: string, fn: () => void) => void;
    expect: (actual: unknown) => {
      to: {
        equal: (expected: unknown) => void;
        be: {
          a: (type: string) => void;
          true: () => void;
          false: () => void;
        };
        have: {
          property: (prop: string) => void;
          length: (len: number) => void;
        };
      };
    };
    response: {
      to: {
        have: {
          status: (code: number) => void;
          header: (key: string, value?: string) => void;
          body: (value?: unknown) => void;
          jsonBody: (path?: string, value?: unknown) => void;
        };
        be: {
          ok: () => void;
          json: () => void;
          html: () => void;
        };
      };
      time: {
        below: (ms: number) => void;
      };
    };
    variables: {
      get: (key: string) => string | undefined;
      set: (key: string, value: string) => void;
    };
  };
}

export interface ScriptResult {
  success: boolean;
  logs: Array<{ type: 'log' | 'error' | 'warn' | 'info'; message: string; timestamp: number }>;
  errors: string[];
  variables: Record<string, string>;
  tests?: Array<{ name: string; passed: boolean; error?: string }>;
  /**
   * Postman-compat mutations the script applied to `pm.globals.*`. `null`
   * means `pm.globals.unset(key)` was called; a string means `set(key, v)`.
   * Callers merge these back into `useGlobalsStore` after eval.
   * (Phase A introduces; Foundations defines the field.)
   */
  globalsMutations?: Record<string, string | null>;
  /**
   * Same shape for `pm.collectionVariables.*` mutations. Phase A wires the
   * collection runner / per-tab collection store to merge these back.
   */
  collectionMutations?: Record<string, string | null>;
  /**
   * Runner flow-control sentinel populated by `pm.execution.setNextRequest`
   * / `skipRequest`. Phase C wires the collection runner to read this.
   */
  execution?: {
    nextRequest?: string | null;
    skipRequested?: boolean;
  };
  /**
   * Captured `pm.visualizer.set(template, data)` payload. Phase D renders
   * this in a sandboxed iframe response tab.
   */
  visualization?: {
    template: string;
    data: unknown;
  };
}

// Security constants
const MAX_EXECUTION_TIME_MS = 5000; // 5s for sync-only scripts
// Async scripts (those using `pm.sendRequest` / `pm.vault.*` — anything
// that returns a host-resolved promise) need a longer ceiling because a
// sub-request itself takes seconds. Selected when any host bridge is bound.
const MAX_EXECUTION_TIME_MS_ASYNC = 30000;
// 64MB — the Phase-B library bundle (~600KB raw) plus a cheerio DOM tree
// for a moderate HTML page comfortably exceeds the legacy 10MB ceiling.
// Per-runtime allocator, freed on dispose().
const MAX_MEMORY_BYTES = 64 * 1024 * 1024;

class ScriptExecutor {
  private envVars: Record<string, string>;
  private globalVars: Record<string, string>;
  /** Collection-scoped variables — separate from envVars per Postman semantics. */
  private collectionVars: Record<string, string>;
  /** Current iteration row exposed via `pm.iterationData` (empty by default). */
  private iterationData: Record<string, string>;
  /** Host-side bridges wired in by the caller (sendRequest, cookies, vault). */
  private host: ScriptHostBridges;
  /** Default `pm.info` applied unless `eval(context.info)` overrides per-call. */
  private defaultInfo: PmRequestInfo;
  /** Default `pm.execution.location` applied unless overridden per-call. */
  private defaultLocation: PmExecutionLocation | undefined;
  /**
   * Per-call cookie adapter — captures the *current* request URL so
   * `pm.cookies.get(name)` / `.has(name)` (Postman scopes those to the
   * current URL) resolve against the right domain. Bound in `eval()`
   * from `context.request.url` and falls back to a no-op adapter for
   * the no-context case.
   */
  private callCookieAdapter: PmCookieAdapter | undefined;
  /** Count of in-flight host-side promises (pm.sendRequest, pm.vault.*). */
  private pendingHostOps = 0;
  private logs: ScriptResult['logs'] = [];
  private errors: string[] = [];
  private tests: Array<{ name: string; passed: boolean; error?: string }> = [];
  /**
   * Mutation trackers, populated by mutation-trapping kv namespaces.
   * Reused across evals (cleared in-place at the start of each `eval()`)
   * because the trapping closures inside QuickJS capture these object
   * references — replacing them would break the binding.
   */
  private readonly globalsMutations: Record<string, string | null> = {};
  private readonly collectionMutations: Record<string, string | null> = {};

  // QuickJS lifecycle. `initialize()` populates these once; `eval()` reuses
  // them across many calls; `dispose()` tears down. The one-shot
  // `executeScript()` path brackets initialize + eval + dispose in a single
  // call, preserving its existing semantics.
  private runtime: QuickJSRuntime | null = null;
  private vm: QuickJSContext | null = null;
  private evalStartTime = 0;
  private evalInterrupted = false;

  constructor(options: ScriptExecutorOptions = {}) {
    this.envVars = { ...(options.envVars ?? {}) };
    this.globalVars = { ...(options.globalVars ?? {}) };
    this.collectionVars = { ...(options.collectionVars ?? {}) };
    this.iterationData = { ...(options.iterationData ?? {}) };
    this.host = options.host ?? {};
    this.defaultInfo = options.info ?? {};
    this.defaultLocation = options.location;
  }

  /** Snapshot the current globals map. Callers merge this back into useGlobalsStore. */
  getGlobals(): Record<string, string> {
    return { ...this.globalVars };
  }

  /** Snapshot the current collection-scoped vars map. */
  getCollectionVars(): Record<string, string> {
    return { ...this.collectionVars };
  }

  /**
   * True iff any host bridge is wired in (sendRequest, cookies, vault).
   * Bridged scripts get the longer async ceiling because a sub-request /
   * keychain unwrap can legitimately take a few seconds.
   */
  private hasAsyncBridges(): boolean {
    return Boolean(this.host.sendRequest ?? this.host.vault ?? this.host.cookies);
  }

  /**
   * Create the QuickJS runtime + context and run the static setup once.
   * Idempotent — subsequent calls return immediately. Required before
   * `eval()`, `setVariable()`, or `bindRequestResponse()` can be used.
   */
  async initialize(): Promise<void> {
    if (this.vm) return;
    const QuickJS = await getQuickJS();
    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(MAX_MEMORY_BYTES);
    // The interrupt handler reads instance fields so each `eval()` call can
    // reset the start time without re-registering the handler.
    runtime.setInterruptHandler(() => {
      // Only enforce timeouts during USER-script eval. `evalStartTime`
      // is set by `eval()` before running the user script and reset to
      // 0 at construction. During `initialize()` (library bundle load,
      // pm.* native setup, PM_EXPECT bootstrap) we must NOT interrupt
      // — those run trusted code we authored, and the 2MB library
      // bundle can take a couple of seconds to parse on slower devices.
      if (this.evalStartTime === 0) return false;
      const ceiling = this.hasAsyncBridges() ? MAX_EXECUTION_TIME_MS_ASYNC : MAX_EXECUTION_TIME_MS;
      if (Date.now() - this.evalStartTime > ceiling) {
        this.evalInterrupted = true;
        return true;
      }
      return false;
    });
    const vm = runtime.newContext();
    this.runtime = runtime;
    this.vm = vm;
    // Load the Postman-compatible library bundle (lodash, chai, crypto-js,
    // moment, uuid, ajv, tv4, csv-parse, xml2js, cheerio, postman-collection).
    // Lazy dynamic import: the chunk only loads the first time any
    // ScriptExecutor.initialize() runs in the session. Failure here is
    // soft — pm.expect / require() are dependent surfaces, and we still
    // want the basic pm.test / pm.variables surface to function for
    // diagnostics.
    try {
      const bundle = await loadSandboxLibraries();
      this.loadLibraryBundle(vm, bundle);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.addLog('error', `Failed to load sandbox library bundle: ${msg}`);
    }
    // Bind console / environment / globals / pm.* and evaluate the
    // expect bootstrap. Request/response are bound per-eval below.
    this.setupQuickJSContext(vm, {});
  }

  /**
   * Eval the library bundle into the QuickJS sandbox:
   *   1. Prelude — Node-shim globals (process, Buffer, setImmediate)
   *      and `atob`/`btoa`.
   *   2. Each library's IIFE source — each one assigns its exports to
   *      `globalThis.__sandboxLib_<name>` (esbuild's `globalName`).
   *   3. The `require()` shim — maps user-facing names like 'lodash'
   *      to the corresponding global and unwraps esbuild's
   *      `{ default: x }` CJS envelope.
   *
   * Errors from any individual library are logged but don't abort —
   * a misbehaving library shouldn't make the whole sandbox unavailable.
   */
  private loadLibraryBundle(
    vm: QuickJSContext,
    bundle: {
      prelude: string;
      sources: Record<string, string>;
      globalNames: Record<string, string>;
    }
  ): void {
    const evalSegment = (label: string, source: string) => {
      const r = vm.evalCode(source);
      if (r.error) {
        const dump = vm.dump(r.error);
        const msg = typeof dump === 'string' ? dump : JSON.stringify(dump);
        this.addLog('error', `[${label}] ${msg}`);
        r.error.dispose();
      } else {
        r.value.dispose();
      }
    };
    evalSegment('sandbox-prelude', bundle.prelude);
    for (const [name, src] of Object.entries(bundle.sources)) {
      if (!src || src.startsWith('/* not bundled')) continue;
      evalSegment(`sandbox-lib:${name}`, src);
    }
    evalSegment('require-shim', buildRequireShimSource(bundle.globalNames));
  }

  /**
   * Update a workflow variable without re-running setup. Variables flow
   * into the QuickJS context via `pm.variables.get(...)` callbacks that
   * close over `this.envVars` — mutating the map here is enough for the
   * next `eval()` to see the new value.
   */
  setVariable(key: string, value: string): void {
    this.envVars[key] = value;
  }

  /**
   * Snapshot the current variables map (`pm.variables.set` and
   * `environment.set` calls mutate the internal copy during eval).
   */
  getVariables(): Record<string, string> {
    return { ...this.envVars };
  }

  /**
   * Dispose the QuickJS runtime + context. Idempotent.
   */
  dispose(): void {
    if (this.vm) {
      this.vm.dispose();
      this.vm = null;
    }
    if (this.runtime) {
      this.runtime.dispose();
      this.runtime = null;
    }
  }

  /**
   * Bind `request`, `response`, `pm.info`, and `pm.execution.location`
   * globals from `context` onto the VM. Called by `eval()` per-invocation
   * — the previous handle is garbage-collected by QuickJS when overwritten.
   *
   * Per-call `context.info` / `context.location` win; absent fields fall
   * back to `defaultInfo` / `defaultLocation` from `fromOptions`. Phase C
   * uses the location field to drive runner flow control.
   */
  private bindRequestResponse(
    vm: QuickJSContext,
    context: {
      request?: ScriptContext['request'];
      response?: ScriptContext['response'];
      info?: PmRequestInfo;
      location?: PmExecutionLocation;
    }
  ): void {
    // Rebuild the per-call cookie adapter so `pm.cookies.get(name)` scopes
    // to the active request URL. The factory comes from the host bridge;
    // when no host.cookies is wired in (CLI without a jar file), pm.cookies
    // methods will return empty results via the undefined-adapter guard.
    this.callCookieAdapter = this.host.cookies?.(context.request?.url);
    if (context.request) {
      const handle = this.makeJSValue(vm, context.request);
      vm.setProp(vm.global, 'request', handle);
      handle.dispose();
    }
    if (context.response) {
      const handle = this.makeJSValue(vm, context.response);
      vm.setProp(vm.global, 'response', handle);
      handle.dispose();
    }
    const info = context.info ?? this.defaultInfo;
    // Bind into pm.info — pm itself is already on the global, set via
    // an eval so we can reach pm.info.requestName etc. with normal
    // property-set semantics rather than another setProp chain.
    const infoPayload = JSON.stringify({
      requestName: info.requestName ?? '',
      requestId: info.requestId ?? '',
      iteration: info.iteration ?? 0,
      iterationCount: info.iterationCount ?? 1,
    });
    const infoR = vm.evalCode(`pm.info = ${infoPayload};`);
    if (infoR.error) infoR.error.dispose();
    else infoR.value.dispose();

    const location = context.location ?? this.defaultLocation;
    if (location) {
      // pm.execution is bootstrapped as an empty object during setup; just
      // mutate its `.location` field per-eval. `setNextRequest` / `skipRequest`
      // land in Phase C and read/write the same `pm.execution` object.
      const locPayload = JSON.stringify({
        currentRequestName: location.currentRequestName,
        folderPath: location.folderPath,
        collectionName: location.collectionName,
      });
      const locR = vm.evalCode(
        `pm.execution = pm.execution || {}; pm.execution.location = ${locPayload};`
      );
      if (locR.error) locR.error.dispose();
      else locR.value.dispose();
    }
  }

  /**
   * Build a QuickJS object exposing get/set/unset/has against a live
   * Record<string,string>. Mutations go straight to the backing map; the
   * caller is responsible for setProp-ing it under the right name and
   * disposing the returned handle.
   *
   * If `mutations` is supplied, every set/unset is also recorded into it
   * (`null` = unset, string = set). The executor surfaces these on
   * `ScriptResult.{globalsMutations,collectionMutations}` so the renderer
   * can merge them back into the corresponding Zustand stores after eval.
   *
   * Shared by `environment`, `globals`, and the four `pm.*` namespaces.
   */
  private buildKvNamespace(
    vm: QuickJSContext,
    store: Record<string, string>,
    mutations?: Record<string, string | null>
  ): QuickJSHandle {
    const ns = vm.newObject();
    const get = vm.newFunction('get', (keyHandle) => {
      const key = vm.getString(keyHandle);
      const value = store[key];
      return value !== undefined ? vm.newString(value) : vm.undefined;
    });
    const set = vm.newFunction('set', (keyHandle, valueHandle) => {
      const k = vm.getString(keyHandle);
      const v = vm.getString(valueHandle);
      store[k] = v;
      if (mutations) mutations[k] = v;
    });
    const unset = vm.newFunction('unset', (keyHandle) => {
      const k = vm.getString(keyHandle);
      delete store[k];
      if (mutations) mutations[k] = null;
    });
    const has = vm.newFunction('has', (keyHandle) => {
      return store[vm.getString(keyHandle)] !== undefined ? vm.true : vm.false;
    });
    vm.setProp(ns, 'get', get);
    vm.setProp(ns, 'set', set);
    vm.setProp(ns, 'unset', unset);
    vm.setProp(ns, 'has', has);
    get.dispose();
    set.dispose();
    unset.dispose();
    has.dispose();
    return ns;
  }

  /**
   * Build the pm.cookies namespace and attach it to pmObj. Each method
   * delegates to `this.callCookieAdapter` (rebound per-eval), so a single
   * binding works across many calls — flipping the adapter at eval-time
   * changes which jar the same `pm.cookies.get` reads.
   */
  private bindPmCookies(vm: QuickJSContext, pmObj: QuickJSHandle): void {
    const ns = vm.newObject();

    const cookiesArrayHandle = (records: PmCookieRecord[]): QuickJSHandle => {
      return this.makeJSValue(vm, records);
    };

    // pm.cookies.get(name)  — value for the first cookie matching name, scoped to current URL
    const getFn = vm.newFunction('get', (nameHandle) => {
      if (!this.callCookieAdapter) return vm.undefined;
      const name = vm.getString(nameHandle);
      const hit = this.callCookieAdapter.forCurrentUrl().find((c) => c.name === name);
      return hit ? vm.newString(hit.value) : vm.undefined;
    });
    // pm.cookies.has(name)  — boolean; current URL scope
    const hasFn = vm.newFunction('has', (nameHandle) => {
      if (!this.callCookieAdapter) return vm.false;
      const name = vm.getString(nameHandle);
      return this.callCookieAdapter.forCurrentUrl().some((c) => c.name === name)
        ? vm.true
        : vm.false;
    });
    // pm.cookies.toJSON() — array of cookie objects for the current URL
    const toJSON = vm.newFunction('toJSON', () => {
      if (!this.callCookieAdapter) return vm.newArray();
      return cookiesArrayHandle(this.callCookieAdapter.forCurrentUrl());
    });

    // pm.cookies.jar() — { get, getAll, set, unset, clear } with explicit URLs
    const jarFn = vm.newFunction('jar', () => {
      const jar = vm.newObject();
      const jarGet = vm.newFunction('get', (urlH, nameH) => {
        if (!this.callCookieAdapter) return vm.undefined;
        const url = vm.getString(urlH);
        const name = vm.getString(nameH);
        const hit = this.callCookieAdapter.getForUrl(url).find((c) => c.name === name);
        return hit ? vm.newString(hit.value) : vm.undefined;
      });
      const jarGetAll = vm.newFunction('getAll', (urlH) => {
        if (!this.callCookieAdapter) return vm.newArray();
        return cookiesArrayHandle(this.callCookieAdapter.getForUrl(vm.getString(urlH)));
      });
      const jarSet = vm.newFunction('set', (urlH, nameH, valueH) => {
        if (!this.callCookieAdapter) return vm.undefined;
        this.callCookieAdapter.add(vm.getString(urlH), {
          name: vm.getString(nameH),
          value: vm.getString(valueH),
        });
        return vm.undefined;
      });
      const jarUnset = vm.newFunction('unset', (urlH, nameH) => {
        if (!this.callCookieAdapter) return vm.undefined;
        this.callCookieAdapter.unset(vm.getString(urlH), vm.getString(nameH));
        return vm.undefined;
      });
      const jarClear = vm.newFunction('clear', (urlH) => {
        if (!this.callCookieAdapter) return vm.undefined;
        this.callCookieAdapter.clear(vm.getString(urlH));
        return vm.undefined;
      });
      vm.setProp(jar, 'get', jarGet);
      vm.setProp(jar, 'getAll', jarGetAll);
      vm.setProp(jar, 'set', jarSet);
      vm.setProp(jar, 'unset', jarUnset);
      vm.setProp(jar, 'clear', jarClear);
      jarGet.dispose();
      jarGetAll.dispose();
      jarSet.dispose();
      jarUnset.dispose();
      jarClear.dispose();
      return jar;
    });

    vm.setProp(ns, 'get', getFn);
    vm.setProp(ns, 'has', hasFn);
    vm.setProp(ns, 'toJSON', toJSON);
    vm.setProp(ns, 'jar', jarFn);
    getFn.dispose();
    hasFn.dispose();
    toJSON.dispose();
    jarFn.dispose();

    vm.setProp(pmObj, 'cookies', ns);
    ns.dispose();
  }

  /**
   * Build `pm.sendRequest(input, [callback])` — the gateway from inside
   * the sandbox to the renderer's HTTP execution path.
   *
   * Returns a QuickJS deferred promise so users can both `await` it AND
   * pass a callback (Postman supports both styles since v9). The host
   * call goes through `this.host.sendRequest`, which is supplied per
   * harness — renderer hosts pass `executeProxiedRequest` (same SSRF
   * guards as a top-level send); CLI hosts pass `undiciFetcher`.
   *
   * `pendingHostOps` is incremented before host work starts and
   * decremented in `finally` so `eval()`'s pump loop knows when there's
   * still work outstanding.
   */
  private bindPmSendRequest(vm: QuickJSContext, pmObj: QuickJSHandle): void {
    const fn = vm.newFunction('sendRequest', (inputHandle, callbackHandle) => {
      const input = vm.dump(inputHandle) as unknown;
      const spec = this.normalizeSendRequestInput(input);
      const deferred = vm.newPromise();
      this.pendingHostOps++;

      // Capture callback as a (cloned) handle if user passed one. We must
      // call `vm.dupHandle` so the user's function survives past this
      // native frame.
      let cbHandle: QuickJSHandle | undefined;
      if (callbackHandle && vm.typeof(callbackHandle) === 'function') {
        cbHandle = callbackHandle.dup();
      }

      const sendRequest = this.host.sendRequest;
      const promise = sendRequest
        ? sendRequest(spec)
        : Promise.reject(new Error('pm.sendRequest: host.sendRequest is not wired in'));

      promise
        .then((response) => {
          const respJs = this.makeJSValue(vm, response as unknown);
          deferred.resolve(respJs);
          if (cbHandle) {
            const errH = vm.null;
            const r = vm.callFunction(cbHandle, vm.undefined, errH, respJs);
            if (r.error) r.error.dispose();
            else r.value.dispose();
          }
          respJs.dispose();
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          const errObj = this.makeJSValue(vm, { message: msg });
          deferred.reject(errObj);
          if (cbHandle) {
            const nullH = vm.null;
            const r = vm.callFunction(cbHandle, vm.undefined, errObj, nullH);
            if (r.error) r.error.dispose();
            else r.value.dispose();
          }
          errObj.dispose();
        })
        .finally(() => {
          this.pendingHostOps--;
          // Drain microtasks the callback / promise continuation queued.
          if (this.runtime) {
            const pending = this.runtime.executePendingJobs();
            if (pending.error) pending.error.dispose();
          }
          if (cbHandle) cbHandle.dispose();
        });

      return deferred.handle;
    });
    vm.setProp(pmObj, 'sendRequest', fn);
    fn.dispose();
  }

  /**
   * Build pm.vault namespace — three async methods returning QuickJS
   * Promises that resolve when the host async work completes. The
   * Promise / pending-counter pattern matches pm.sendRequest above.
   */
  private bindPmVault(vm: QuickJSContext, pmObj: QuickJSHandle): void {
    const ns = vm.newObject();

    const wrapAsync = <T>(work: () => Promise<T>, onResolve: (value: T) => QuickJSHandle) => {
      const deferred = vm.newPromise();
      this.pendingHostOps++;
      work()
        .then((value) => {
          const h = onResolve(value);
          deferred.resolve(h);
          h.dispose();
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          const e = this.makeJSValue(vm, { message: msg });
          deferred.reject(e);
          e.dispose();
        })
        .finally(() => {
          this.pendingHostOps--;
          if (this.runtime) {
            const pending = this.runtime.executePendingJobs();
            if (pending.error) pending.error.dispose();
          }
        });
      return deferred.handle;
    };

    const noHost = (op: string) =>
      Promise.reject(new Error(`pm.vault.${op}: no host adapter wired in this build`));

    const getFn = vm.newFunction('get', (keyHandle) => {
      const key = vm.getString(keyHandle);
      return wrapAsync(
        () => (this.host.vault ? this.host.vault.get(key) : noHost('get')),
        (value) => (value === undefined ? vm.undefined : vm.newString(String(value)))
      );
    });
    const setFn = vm.newFunction('set', (keyHandle, valueHandle) => {
      const key = vm.getString(keyHandle);
      const value = vm.getString(valueHandle);
      return wrapAsync(
        () => (this.host.vault ? this.host.vault.set(key, value) : noHost('set')),
        () => vm.undefined
      );
    });
    const unsetFn = vm.newFunction('unset', (keyHandle) => {
      const key = vm.getString(keyHandle);
      return wrapAsync(
        () => (this.host.vault ? this.host.vault.unset(key) : noHost('unset')),
        () => vm.undefined
      );
    });
    vm.setProp(ns, 'get', getFn);
    vm.setProp(ns, 'set', setFn);
    vm.setProp(ns, 'unset', unsetFn);
    getFn.dispose();
    setFn.dispose();
    unsetFn.dispose();
    vm.setProp(pmObj, 'vault', ns);
    ns.dispose();
  }

  /**
   * Turn the user's `pm.sendRequest` argument into the host's
   * `PmSendRequestInput` shape. Postman accepts a bare URL string OR a
   * request object with `url / method / header / body`. We tolerate both.
   */
  private normalizeSendRequestInput(input: unknown): PmSendRequestInput {
    if (typeof input === 'string') {
      return { url: input, method: 'GET' };
    }
    if (input && typeof input === 'object') {
      const o = input as Record<string, unknown>;
      const url = typeof o.url === 'string' ? o.url : '';
      const method = typeof o.method === 'string' ? o.method : 'GET';
      const headers =
        o.header && typeof o.header === 'object'
          ? (o.header as Record<string, string>)
          : o.headers && typeof o.headers === 'object'
            ? (o.headers as Record<string, string>)
            : {};
      const body = o.body;
      return { url, method, headers, body };
    }
    return { url: '', method: 'GET' };
  }

  /** Native → QuickJS handle. Extracted from setupQuickJSContext so the
   *  per-eval request/response rebind can reuse it. */
  private makeJSValue(vm: QuickJSContext, value: unknown): QuickJSHandle {
    if (value === undefined) return vm.undefined;
    if (value === null) return vm.null;
    if (typeof value === 'boolean') return value ? vm.true : vm.false;
    if (typeof value === 'number') return vm.newNumber(value);
    if (typeof value === 'string') return vm.newString(value);
    if (Array.isArray(value)) {
      const arr = vm.newArray();
      value.forEach((item, i) => {
        const itemHandle = this.makeJSValue(vm, item);
        vm.setProp(arr, i, itemHandle);
        itemHandle.dispose();
      });
      return arr;
    }
    if (typeof value === 'object') {
      const obj = vm.newObject();
      for (const [key, val] of Object.entries(value)) {
        const valHandle = this.makeJSValue(vm, val);
        vm.setProp(obj, key, valHandle);
        valHandle.dispose();
      }
      return obj;
    }
    return vm.undefined;
  }

  /**
   * Evaluate a script inside the initialized session. Resets per-call
   * state (logs/errors/tests/timeout), optionally rebinds request/response,
   * runs the script, and returns the result shape.
   *
   * Throws if the session is not initialized. Callers that don't need a
   * long-lived session should use `executeScript()` instead.
   */
  async eval(
    script: string,
    context: {
      request?: ScriptContext['request'];
      response?: ScriptContext['response'];
      info?: PmRequestInfo;
      location?: PmExecutionLocation;
    } = {}
  ): Promise<ScriptResult> {
    const vm = this.vm;
    if (!vm) {
      throw new Error('ScriptExecutor.eval called before initialize()');
    }

    this.logs = [];
    this.errors = [];
    this.tests = [];
    // Clear mutation trackers in place — the QuickJS closures bound at
    // setup time reference these object identities, so we can't replace them.
    for (const k of Object.keys(this.globalsMutations)) delete this.globalsMutations[k];
    for (const k of Object.keys(this.collectionMutations)) delete this.collectionMutations[k];
    // Reset the per-eval sentinels (execution flow control + visualizer).
    // We use a tiny eval rather than setProp so we don't have to manage
    // QuickJS handles for transient state.
    const sentinelReset = vm.evalCode(
      `globalThis.__pm_execution_state__ = { nextRequest: undefined, skipRequested: false }; ` +
        `globalThis.__pm_visualization__ = undefined;`
    );
    if (sentinelReset.error) sentinelReset.error.dispose();
    else sentinelReset.value.dispose();

    const trimmedScript = typeof script === 'string' ? script.trim() : '';
    if (!trimmedScript) {
      return {
        success: true,
        logs: this.logs,
        errors: this.errors,
        variables: { ...this.envVars },
      };
    }

    this.bindRequestResponse(vm, context);
    this.evalStartTime = Date.now();
    this.evalInterrupted = false;

    const result = vm.evalCode(trimmedScript, 'user-script.js');
    if (result.error) {
      const errorValue = vm.dump(result.error);
      const errorMsg = typeof errorValue === 'string' ? errorValue : JSON.stringify(errorValue);
      this.addLog('error', `Script execution error: ${errorMsg}`);
      result.error.dispose();
    } else {
      result.value.dispose();
    }
    // Drain microtasks the script queued (await / .then / promise chains).
    // For sync-only scripts this is a single immediate call. For scripts
    // that called pm.sendRequest, we loop: pump QuickJS microtasks, yield
    // to the host event loop so the in-flight Promise can resolve, then
    // pump again — until no host-side work is outstanding (or we hit the
    // execution-time ceiling enforced by the interrupt handler).
    if (this.runtime) {
      const pending = this.runtime.executePendingJobs();
      if (pending.error) pending.error.dispose();
    }
    while (this.pendingHostOps > 0 && !this.evalInterrupted) {
      // Yield once to the host so any pending Promise.then() callbacks
      // attached by pm.sendRequest can fire. setImmediate isn't available
      // in browsers; setTimeout(0) is the portable equivalent.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (this.runtime) {
        const pending = this.runtime.executePendingJobs();
        if (pending.error) pending.error.dispose();
      }
    }
    if (this.evalInterrupted) {
      const ceiling = this.hasAsyncBridges() ? MAX_EXECUTION_TIME_MS_ASYNC : MAX_EXECUTION_TIME_MS;
      this.addLog('error', `Script execution timed out after ${ceiling}ms`);
      this.errors.push(`Script execution timed out after ${ceiling}ms`);
    }

    // Harvest the per-eval sentinels back into the result shape. Both are
    // optional — absent when the script didn't touch them. We tolerate
    // malformed JSON silently because the bootstrap above writes well-formed
    // values; a parse error here would mean a user script tampered with the
    // sentinel global, in which case "ignore and move on" matches Postman's
    // permissive behaviour.
    const execution = this.readExecutionSentinel(vm);
    const visualization = this.readVisualizationSentinel(vm);

    const hasGlobalsMutations = Object.keys(this.globalsMutations).length > 0;
    const hasCollectionMutations = Object.keys(this.collectionMutations).length > 0;

    return {
      success: this.errors.length === 0,
      logs: this.logs,
      errors: this.errors,
      variables: { ...this.envVars },
      ...(this.tests.length > 0 && { tests: this.tests }),
      ...(hasGlobalsMutations && { globalsMutations: { ...this.globalsMutations } }),
      ...(hasCollectionMutations && { collectionMutations: { ...this.collectionMutations } }),
      ...(execution && { execution }),
      ...(visualization && { visualization }),
    };
  }

  /** Read `__pm_execution_state__` back into the typed sentinel shape. */
  private readExecutionSentinel(vm: QuickJSContext): ScriptResult['execution'] | undefined {
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
  private readVisualizationSentinel(vm: QuickJSContext): ScriptResult['visualization'] | undefined {
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

  private stringify(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  private addLog(type: 'log' | 'error' | 'warn' | 'info', message: string) {
    this.logs.push({
      type,
      message,
      timestamp: Date.now(),
    });
    if (type === 'error') {
      this.errors.push(message);
    }
  }

  private addTest(name: string, passed: boolean, error?: string) {
    this.tests.push({ name, passed, ...(error !== undefined && { error }) });
    if (passed) {
      this.addLog('info', `✓ ${name}`);
    } else {
      this.addLog('error', `✗ ${name}: ${error || 'Test failed'}`);
    }
  }

  // One-time setup of console / environment / globals / pm.* helpers
  // and the utils + expect eval-time code. Request / response globals
  // are bound per-eval by `bindRequestResponse` so a session can serve
  // many calls against different request/response shapes.
  private setupQuickJSContext(
    vm: QuickJSContext,
    _context: {
      request?: ScriptContext['request'];
      response?: ScriptContext['response'];
    }
  ): void {
    void _context; // retained for signature compatibility; per-eval globals live in eval()
    const fromJSValue = (handle: QuickJSHandle): unknown => {
      return vm.dump(handle);
    };

    // Setup console object
    const consoleObj = vm.newObject();

    const createConsoleMethod = (type: 'log' | 'error' | 'warn' | 'info') => {
      return vm.newFunction(type, (...args) => {
        const messages = args.map((arg) => this.stringify(fromJSValue(arg)));
        this.addLog(type, messages.join(' '));
      });
    };

    const logFn = createConsoleMethod('log');
    const errorFn = createConsoleMethod('error');
    const warnFn = createConsoleMethod('warn');
    const infoFn = createConsoleMethod('info');

    vm.setProp(consoleObj, 'log', logFn);
    vm.setProp(consoleObj, 'error', errorFn);
    vm.setProp(consoleObj, 'warn', warnFn);
    vm.setProp(consoleObj, 'info', infoFn);

    vm.setProp(vm.global, 'console', consoleObj);

    logFn.dispose();
    errorFn.dispose();
    warnFn.dispose();
    infoFn.dispose();
    consoleObj.dispose();

    // Top-level `environment` and `globals` namespaces. Both expose the
    // same get/set/unset/has surface as their `pm.*` aliases below.
    const envObj = this.buildKvNamespace(vm, this.envVars);
    vm.setProp(vm.global, 'environment', envObj);
    envObj.dispose();

    const globalsObj = this.buildKvNamespace(vm, this.globalVars);
    vm.setProp(vm.global, 'globals', globalsObj);
    globalsObj.dispose();

    // Setup pm (Postman-compatible) API
    const pmObj = vm.newObject();

    // pm.test
    const testFn = vm.newFunction('test', (nameHandle, fnHandle) => {
      const name = vm.getString(nameHandle);
      try {
        const result = vm.callFunction(fnHandle, vm.undefined);
        if (result.error) {
          const dumped = vm.dump(result.error) as unknown;
          // QuickJS dumps an Error as { name, message, stack }. Extract
          // the message so a failing assertion shows the user the actual
          // assertion text rather than `[object Object]`.
          const msg =
            typeof dumped === 'string'
              ? dumped
              : dumped && typeof dumped === 'object' && 'message' in dumped
                ? String((dumped as { message: unknown }).message)
                : String(dumped);
          this.addTest(name, false, msg);
          result.error.dispose();
        } else {
          this.addTest(name, true);
          result.value.dispose();
        }
      } catch (err) {
        this.addTest(name, false, err instanceof Error ? err.message : String(err));
      }
    });
    vm.setProp(pmObj, 'test', testFn);
    testFn.dispose();

    // pm.variables / pm.globals / pm.environment / pm.collectionVariables —
    // four Postman namespaces. `pm.variables` aliases `pm.environment` (the
    // active resolution scope at the script's request). `pm.collectionVariables`
    // uses the dedicated collectionVars map when supplied via fromOptions,
    // and aliases envVars when the legacy positional constructor is used.
    //
    // Mutation trackers are wired for `globals` and `collectionVariables`
    // (the two stores callers persist back to Zustand). `environment` /
    // `variables` mutations come back via `result.variables` (legacy
    // contract preserved); the renderer's request executor already merges
    // that map back into the active environment.
    const kvBindings: Array<
      [string, Record<string, string>, Record<string, string | null> | undefined]
    > = [
      ['variables', this.envVars, undefined],
      ['globals', this.globalVars, this.globalsMutations],
      ['environment', this.envVars, undefined],
      ['collectionVariables', this.collectionVars, this.collectionMutations],
    ];
    for (const [name, map, mutations] of kvBindings) {
      const ns = this.buildKvNamespace(vm, map, mutations);
      vm.setProp(pmObj, name, ns);
      ns.dispose();
    }

    // pm.iterationData — real backing map (empty for non-runner calls).
    // Same get/set/unset/has surface as the other pm.* namespaces, plus
    // toObject() for Postman compatibility.
    const pmIterData = this.buildKvNamespace(vm, this.iterationData);
    const pmIterToObject = vm.newFunction('toObject', () => {
      return this.makeJSValue(vm, { ...this.iterationData });
    });
    vm.setProp(pmIterData, 'toObject', pmIterToObject);
    vm.setProp(pmObj, 'iterationData', pmIterData);
    pmIterToObject.dispose();
    pmIterData.dispose();

    // pm.cookies — read/write the renderer's persistent cookie jar.
    // Per-eval `bindRequestResponse` overwrites `this.callCookieAdapter`
    // so `pm.cookies.get(name)` resolves against the active request URL.
    this.bindPmCookies(vm, pmObj);

    // pm.sendRequest — only bound when a host.sendRequest closure is
    // wired in. The callback / promise machinery is non-trivial; see
    // bindPmSendRequest for the deferred-promise + pending-counter dance.
    if (this.host.sendRequest) {
      this.bindPmSendRequest(vm, pmObj);
    }

    // pm.vault — async key-value secret store. Each method returns a
    // QuickJS Promise that resolves when the host async work (IPC →
    // electron-store on desktop, rejection on web) completes. Bound
    // unconditionally; if no host.vault is wired in, each method
    // rejects with a clean "no adapter" error so scripts fail loudly
    // rather than hanging.
    this.bindPmVault(vm, pmObj);

    // Put pm on the global BEFORE we eval any code that references it
    // (the pm.info default and PM_EXPECT_BOOTSTRAP both expect `pm` to exist).
    // Dispose the local handle here — the QuickJS GC keeps the underlying
    // object alive via the global.pm reference. Subsequent `pm.<anything> = …`
    // assignments inside eval'd setup blocks mutate the same JS object.
    vm.setProp(vm.global, 'pm', pmObj);
    pmObj.dispose();

    // pm.info — default empty; per-eval bindRequestResponse() overwrites with
    // the active request's name/id when available.
    const pmInfo = vm.evalCode(
      "pm.info = { requestName: '', requestId: '', iteration: 0, iterationCount: 1 };"
    );
    if (pmInfo.error) pmInfo.error.dispose();
    else pmInfo.value.dispose();

    // pm.expect via require('chai') + pm.response convenience wrappers.
    // Imported from pmExpect.ts. The legacy chaiSubset.ts has been removed
    // — the full chai library is now available via the require() shim.
    const setupResult = vm.evalCode(PM_EXPECT_BOOTSTRAP);
    if (setupResult.error) {
      const errorMsg = vm.dump(setupResult.error);
      this.addLog('error', `Failed to setup pm API: ${errorMsg}`);
      setupResult.error.dispose();
    } else {
      setupResult.value.dispose();
    }

    // pm.execution — runner flow control. The two methods write into a
    // sentinel global that the executor reads back into ScriptResult.execution
    // after eval(). The collection runner (Phase C) consumes that field.
    // We bootstrap the sentinel itself per-eval (in `eval`) so the result
    // is scoped to the current call, not leaked across reused sessions.
    const executionBootstrap = vm.evalCode(`
      pm.execution = pm.execution || {};
      pm.execution.setNextRequest = function (name) {
        globalThis.__pm_execution_state__ = globalThis.__pm_execution_state__ || {};
        globalThis.__pm_execution_state__.nextRequest = (name === null || name === undefined)
          ? null
          : String(name);
      };
      pm.execution.skipRequest = function () {
        globalThis.__pm_execution_state__ = globalThis.__pm_execution_state__ || {};
        globalThis.__pm_execution_state__.skipRequested = true;
      };
      // pm.visualizer.set captured per eval; surfaced on ScriptResult.visualization.
      pm.visualizer = {
        set: function (template, data) {
          globalThis.__pm_visualization__ = {
            template: String(template == null ? '' : template),
            data: data,
          };
        },
      };
    `);
    if (executionBootstrap.error) {
      const errorMsg = vm.dump(executionBootstrap.error);
      this.addLog('error', `Failed to setup pm.execution: ${errorMsg}`);
      executionBootstrap.error.dispose();
    } else {
      executionBootstrap.value.dispose();
    }
  }

  /**
   * One-shot execution: initialize → eval → dispose. Each call gets a
   * fresh QuickJS runtime. Callers that need to run many scripts against
   * the same session (e.g. high-frequency predicate evaluation) should
   * call `initialize()` / `eval()` / `dispose()` directly so the runtime
   * is reused.
   *
   * The QuickJS WASM runtime is the security boundary — it's isolated
   * with no host bridge, so eval / Function() / __proto__ / constructor[]
   * inside the user script cannot reach any native API. See ADR-0004.
   */
  async executeScript(
    script: string,
    context: {
      request?: ScriptContext['request'];
      response?: ScriptContext['response'];
      info?: PmRequestInfo;
      location?: PmExecutionLocation;
    }
  ): Promise<ScriptResult> {
    try {
      await this.initialize();
      return await this.eval(script, context);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.errors.push(errorMsg);
      this.logs.push({
        type: 'error',
        message: `Sandbox initialization failed: ${errorMsg}`,
        timestamp: Date.now(),
      });
      return {
        success: false,
        logs: this.logs,
        errors: this.errors,
        variables: { ...this.envVars },
        ...(this.tests.length > 0 && { tests: this.tests }),
      };
    } finally {
      this.dispose();
    }
  }
}

export default ScriptExecutor;
