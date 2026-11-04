// Scripting Sandbox for Pre-request and Test Scripts
// Provides a SECURE sandboxed environment using QuickJS for executing user scripts
// Security features: Memory limits, execution timeout, no filesystem/network access

import type {
  JudgeAnchor,
  JudgeCriterion,
  JudgeRequestInput,
  JudgeVerdict,
} from '@shared/protocol/ai/judge';
import type { QuickJSContext, QuickJSHandle, QuickJSRuntime } from 'quickjs-emscripten';
import { getQuickJS } from 'quickjs-emscripten';
import { PM_EXPECT_BOOTSTRAP } from './expect-bootstrap';
import { buildRequireShimSource, loadSandboxLibraries } from './sandbox-libraries';
import {
  QUICKJS_MAX_EXECUTION_TIME_MS,
  QUICKJS_MAX_EXECUTION_TIME_MS_ASYNC,
  QUICKJS_MAX_MEMORY_BYTES,
  QUICKJS_MAX_STACK_BYTES,
} from './sandbox-limits';
import {
  bindPmCookies,
  buildKvNamespace,
  hasOwnKey,
  readOwnKey,
} from './script-executor-namespaces';
import {
  bindRequestGlobal,
  readRequestHeaders,
  readRequestMetadata,
} from './script-executor-request';
import { installPmTest, PmTestRecorder } from './script-executor-tests';
import type {
  PmCookieAdapter,
  PmExecutionLocation,
  PmRequestInfo,
  ScriptContext,
  ScriptExecutorOptions,
  ScriptHostBridges,
  ScriptResult,
} from './script-executor-types';
import { makeJSValue, normalizeSendRequestInput, sandboxResponse } from './script-executor-values';

export type {
  PmCookieAdapter,
  PmCookieRecord,
  PmExecutionLocation,
  PmRequestInfo,
  PmSendRequestInput,
  PmSubResponse,
  PmVaultAdapter,
  ScriptContext,
  ScriptExecutorOptions,
  ScriptHostBridges,
  ScriptResult,
} from './script-executor-types';

// Security constants — shared with the other QuickJS sandboxes.
const MAX_EXECUTION_TIME_MS = QUICKJS_MAX_EXECUTION_TIME_MS;
const MAX_EXECUTION_TIME_MS_ASYNC = QUICKJS_MAX_EXECUTION_TIME_MS_ASYNC;
const MAX_MEMORY_BYTES = QUICKJS_MAX_MEMORY_BYTES;
const MAX_STACK_BYTES = QUICKJS_MAX_STACK_BYTES;

/**
 * The Postman surface of `pm.sendRequest(request, [callback])` over the native
 * `pm.__sendRequestNative`. The response gets `json()`, `text()` and a
 * case-insensitive `headers.get()` / `has()` (non-enumerable, so the response
 * still serialises as before). With a callback, the host error goes to the
 * callback rather than rejecting the returned promise, and anything the
 * callback throws (or an async callback rejects with) is a script error.
 */
const SEND_REQUEST_WRAPPER = `(function () {
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
  /**
   * Cleanup callbacks for in-flight host promises. Each pending op
   * registers a function that frees its allocated handles (the QuickJS
   * deferred wrapper plus any cbHandle the user passed). On wall-clock
   * timeout or `dispose()` we iterate this set, run every cleanup, and
   * clear — without this, QuickJS's `JS_FreeRuntime` asserts on a
   * non-empty `gc_obj_list` and crashes the host process.
   *
   * The corresponding host-side .then/.catch/.finally also call their
   * own cleanup once the promise settles; the `Set` membership check is
   * the idempotency guard so a settle-after-cleanup is a no-op.
   */
  private readonly pendingHostCleanups = new Set<() => void>();
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
  private readonly environmentMutations: Record<string, string | null> = {};
  /** `pm.test` outcomes in call order, including async tests that settle later. */
  private readonly testRecorder = new PmTestRecorder(
    () => this.tests,
    (type, message) => this.pushLog(type, message)
  );
  /**
   * Keys `pm.variables.set` / `pm.environment.set|unset` wrote in this eval:
   * their value in `envVars` is the script's own, above collection and globals.
   */
  private readonly scriptWrittenVars = new Set<string>();
  /** Collection and globals values as each eval started (see {@link resolveVariable}). */
  private scopeBaseline: { collection: Record<string, string>; globals: Record<string, string> } = {
    collection: {},
    globals: {},
  };
  /**
   * Test-only override. Production code never sets this; tests inject a
   * short ceiling so the wall-clock-deadline path is exercised in
   * sub-second time. When undefined, the synchronous-vs-async constants
   * apply unchanged.
   */
  private syncCeilingOverrideMs: number | undefined;
  private asyncCeilingOverrideMs: number | undefined;

  // QuickJS lifecycle. `initialize()` populates these once; `eval()` reuses
  // them across many calls; `dispose()` tears down. The one-shot
  // `executeScript()` path brackets initialize + eval + dispose in a single
  // call, preserving its existing semantics.
  private runtime: QuickJSRuntime | null = null;
  private vm: QuickJSContext | null = null;
  /**
   * Wall-clock start of the currently-running `eval()` (set on entry, so its
   * setup, user script and harvest share one ceiling), or `0` outside it.
   *
   * **Contract**: the interrupt handler and the async pump skip
   * enforcement whenever this is `0` — that's how `initialize()`'s
   * trusted bundle / pm.* / setup evals run untimed. For the same reason
   * host settles and job drains never touch the VM while it is `0`. Anything that
   * calls `vm.evalCode(...)` directly outside `eval()` runs without a
   * timeout. If you add such a call site, decide explicitly whether it
   * should be bounded and set `evalStartTime` accordingly before the
   * eval (then restore to `0` after).
   */
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
   * True iff any host bridge is wired in (sendRequest, vault, cookies, judge).
   * Bridged scripts get the longer async ceiling because a sub-request /
   * keychain unwrap / LLM judge call can legitimately take a few seconds.
   */
  private hasAsyncBridges(): boolean {
    return Boolean(
      this.host.sendRequest ?? this.host.vault ?? this.host.cookies ?? this.host.judge
    );
  }

  /**
   * Run every registered host-promise cleanup. Each callback rejects +
   * disposes its QuickJS deferred and disposes any cbHandle the caller
   * captured. Called from the wall-clock timeout path and from
   * `dispose()` — anything left in the set would otherwise trip
   * QuickJS's `gc_obj_list` assertion when the runtime is torn down.
   */
  private releasePendingHostOps(): void {
    if (this.pendingHostCleanups.size === 0) return;
    for (const cleanup of this.pendingHostCleanups) {
      try {
        cleanup();
      } catch {
        // Best-effort — keep iterating so a single bad cleanup doesn't
        // strand others.
      }
    }
    this.pendingHostCleanups.clear();
    // Drain so any .then() chains waiting on the rejected deferreds run
    // (only inside a timed eval; from dispose() they are freed undrained).
    this.drainJobs();
  }

  /**
   * Run queued jobs only inside `eval()`, where the interrupt handler bounds
   * them; a host op settling after its eval (started by a handler during the
   * timeout drain) leaves its reactions queued for the next eval's deadline.
   */
  private drainJobs(): void {
    if (!this.runtime || this.evalStartTime === 0) return;
    const pending = this.runtime.executePendingJobs();
    if (pending.error) pending.error.dispose();
  }

  /**
   * A host settle may touch the VM only for a live op inside an eval: resolve
   * can hit a user `then` getter and the callback is user code.
   */
  private canSettle(cleanup: () => void): boolean {
    return this.evalStartTime !== 0 && !!this.runtime && this.pendingHostCleanups.has(cleanup);
  }

  private executionCeilingMs(): number {
    if (this.hasAsyncBridges()) {
      return this.asyncCeilingOverrideMs ?? MAX_EXECUTION_TIME_MS_ASYNC;
    }
    return this.syncCeilingOverrideMs ?? MAX_EXECUTION_TIME_MS;
  }

  /**
   * Test-only setter. Production code does not touch this — call sites
   * rely on the module-level constants. Tests use it to exercise the
   * timeout path without a real-time wait.
   */
  __setCeilingsForTest(syncMs: number | undefined, asyncMs: number | undefined): void {
    this.syncCeilingOverrideMs = syncMs;
    this.asyncCeilingOverrideMs = asyncMs;
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
    runtime.setMaxStackSize(MAX_STACK_BYTES);
    // The interrupt handler reads instance fields so each `eval()` call can
    // reset the start time without re-registering the handler.
    runtime.setInterruptHandler(() => {
      // Only enforce timeouts inside `eval()`, which is timed end to end
      // (its setup and harvest evals can hit user-installed accessors) and
      // resets `evalStartTime` to 0 on exit. `initialize()` (library bundle,
      // pm.* setup, PM_EXPECT bootstrap) runs our own code untimed: the 2MB
      // bundle can take seconds to parse on slower devices.
      if (this.evalStartTime === 0) return false;
      const ceiling = this.executionCeilingMs();
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
   *
   * Order matters: any pending host-promise deferreds must be released
   * BEFORE the runtime tear-down, otherwise QuickJS asserts on leaked
   * handles and crashes the host process. Any in-flight host JS promise
   * that settles later finds `this.runtime === null` and no-ops.
   */
  dispose(): void {
    if (this.vm) {
      this.releasePendingHostOps();
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
    if (context.request) bindRequestGlobal(vm, context.request);
    if (context.response) {
      const handle = makeJSValue(vm, sandboxResponse(context.response));
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
      eventName: info.eventName ?? '',
    });
    const infoR = vm.evalCode(`pm.info = ${infoPayload};`);
    if (infoR.error) infoR.error.dispose();
    else infoR.value.dispose();

    // pm.execution is bootstrapped as an empty object during setup; just
    // mutate its `.location` field per-eval. `setNextRequest` / `skipRequest`
    // land in Phase C and read/write the same `pm.execution` object. Always
    // set a (possibly empty) location object — a one-off request has no
    // collection/folder context, but a script that reads
    // `pm.execution.location.collectionName` unconditionally (matching real
    // Postman usage inside a collection run) must not throw a TypeError.
    const location = context.location ?? this.defaultLocation;
    const locPayload = JSON.stringify({
      currentRequestName: location?.currentRequestName ?? '',
      folderPath: location?.folderPath ?? [],
      collectionName: location?.collectionName ?? '',
    });
    const locR = vm.evalCode(
      `pm.execution = pm.execution || {}; pm.execution.location = ${locPayload};`
    );
    if (locR.error) locR.error.dispose();
    else locR.value.dispose();
  }

  /**
   * Bind the native half of `pm.sendRequest`: `input` in, a QuickJS promise of
   * the sub-response out. The Postman surface (the optional callback, the
   * response's `json()` / `text()` / `headers.get()`) is the JS wrapper
   * `SEND_REQUEST_WRAPPER` installs over it. The host call goes through
   * `this.host.sendRequest`, supplied per harness (renderer hosts pass
   * `executeProxiedRequest`, with the same SSRF guards as a top-level send).
   * Bound on every host: without one the promise rejects with a clear error
   * (the CLI has no sub-request path), never a `TypeError: not a function`.
   */
  private bindPmSendRequest(vm: QuickJSContext, pmObj: QuickJSHandle): void {
    const fn = vm.newFunction('sendRequest', (inputHandle) => {
      const input = inputHandle ? (vm.dump(inputHandle) as unknown) : undefined;
      const spec = normalizeSendRequestInput(input);
      const sendRequest = this.host.sendRequest;
      return this.wrapAsyncHostOp(
        vm,
        () =>
          sendRequest
            ? sendRequest(spec)
            : Promise.reject(
                new Error(
                  'pm.sendRequest is not available in this host: it has no sub-request path (the CLI sends none)'
                )
              ),
        (response) => makeJSValue(vm, sandboxResponse(response))
      );
    });
    vm.setProp(pmObj, '__sendRequestNative', fn);
    fn.dispose();
  }

  /**
   * Shared async-host-op machinery for `pm.vault` / `rs.judge` (and any
   * future host bridge that returns a host-resolved promise). Creates a
   * QuickJS deferred, increments `pendingHostOps`, registers a cleanup in
   * `pendingHostCleanups` (so a wall-clock timeout / `dispose()` can reject
   * + free the deferred before the runtime is torn down — QuickJS asserts
   * on leaked handles otherwise), and settles the deferred when `work()`
   * resolves/rejects. Lifted out of `bindPmVault` so `bindPmJudge` reuses
   * the exact same memory-safe lifecycle.
   */
  private wrapAsyncHostOp<T>(
    vm: QuickJSContext,
    work: () => Promise<T>,
    onResolve: (value: T) => QuickJSHandle
  ): QuickJSHandle {
    const deferred = vm.newPromise();
    this.pendingHostOps++;
    const cleanup = (): void => {
      if (!this.pendingHostCleanups.has(cleanup)) return;
      this.pendingHostCleanups.delete(cleanup);
      if (this.runtime && deferred.alive) {
        try {
          const err = vm.newError('Script execution interrupted');
          deferred.reject(err);
          err.dispose();
        } catch {
          // vm in tear-down
        }
      }
      if (deferred.alive) {
        try {
          deferred.dispose();
        } catch {
          // already disposed
        }
      }
    };
    this.pendingHostCleanups.add(cleanup);
    work()
      .then((value) => {
        // Bail if dispose() ran during host work — every handle below
        // is owned by the vm that's now gone.
        if (!this.canSettle(cleanup)) return;
        const h = onResolve(value);
        deferred.resolve(h);
        h.dispose();
      })
      .catch((err: unknown) => {
        if (!this.canSettle(cleanup)) return;
        const msg = err instanceof Error ? err.message : String(err);
        const e = makeJSValue(vm, { message: msg });
        deferred.reject(e);
        e.dispose();
      })
      .finally(() => {
        this.pendingHostOps--;
        cleanup();
        this.drainJobs();
      });
    return deferred.handle;
  }

  /**
   * Build pm.vault namespace — three async methods returning QuickJS
   * Promises that resolve when the host async work completes. The
   * Promise / pending-counter pattern matches pm.sendRequest above.
   */
  private bindPmVault(vm: QuickJSContext, pmObj: QuickJSHandle): void {
    const ns = vm.newObject();

    const noHost = (op: string) =>
      Promise.reject(new Error(`pm.vault.${op}: no host adapter wired in this build`));

    const getFn = vm.newFunction('get', (keyHandle) => {
      const key = vm.getString(keyHandle);
      return this.wrapAsyncHostOp(
        vm,
        () => (this.host.vault ? this.host.vault.get(key) : noHost('get')),
        (value) => (value === undefined ? vm.undefined : vm.newString(String(value)))
      );
    });
    const setFn = vm.newFunction('set', (keyHandle, valueHandle) => {
      const key = vm.getString(keyHandle);
      const value = vm.getString(valueHandle);
      return this.wrapAsyncHostOp(
        vm,
        () => (this.host.vault ? this.host.vault.set(key, value) : noHost('set')),
        () => vm.undefined
      );
    });
    const unsetFn = vm.newFunction('unset', (keyHandle) => {
      const key = vm.getString(keyHandle);
      return this.wrapAsyncHostOp(
        vm,
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
   * Bind `rs.judge(output, opts)` — a semantic assertion that asks an LLM
   * judge to evaluate `output` against `opts.rubric` (optional `reference`
   * / `passThreshold`). Returns a QuickJS Promise resolving to a verdict
   * `{ pass, score, reasoning }`. Routes through `this.host.judge`; bound
   * unconditionally (mirrors `pm.vault`) so it rejects cleanly when no judge
   * is wired. Reuses `wrapAsyncHostOp` for the deferred/cleanup lifecycle.
   */
  private bindPmJudge(vm: QuickJSContext, pmObj: QuickJSHandle): void {
    const fn = vm.newFunction('judge', (outputHandle, optsHandle) => {
      const output =
        vm.typeof(outputHandle) === 'string'
          ? vm.getString(outputHandle)
          : this.stringify(vm.dump(outputHandle));
      const optsRaw = optsHandle ? (vm.dump(optsHandle) as unknown) : undefined;
      const opts =
        optsRaw && typeof optsRaw === 'object' ? (optsRaw as Record<string, unknown>) : {};
      const rubric = typeof opts.rubric === 'string' ? opts.rubric : '';
      const reference = typeof opts.reference === 'string' ? opts.reference : undefined;
      const passThreshold = typeof opts.passThreshold === 'number' ? opts.passThreshold : undefined;
      // Hardened judge knobs: multi-criteria rubric, self-consistency sampling,
      // calibration anchors. vm.dump deep-copies these into plain JS objects.
      const criteria = Array.isArray(opts.criteria)
        ? (opts.criteria as JudgeCriterion[])
        : undefined;
      const anchors = Array.isArray(opts.anchors) ? (opts.anchors as JudgeAnchor[]) : undefined;
      const samples = typeof opts.samples === 'number' ? opts.samples : undefined;
      const input: JudgeRequestInput = {
        output,
        rubric,
        ...(criteria && { criteria }),
        ...(samples !== undefined && { samples }),
        ...(anchors && { anchors }),
        ...(reference !== undefined && { reference }),
        ...(passThreshold !== undefined && { passThreshold }),
      };
      const judge = this.host.judge;
      return this.wrapAsyncHostOp<JudgeVerdict>(
        vm,
        () =>
          judge
            ? judge(input)
            : Promise.reject(new Error('rs.judge: host.judge is not wired in this build')),
        (verdict) => makeJSValue(vm, verdict as unknown)
      );
    });
    vm.setProp(pmObj, 'judge', fn);
    fn.dispose();
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
    for (const k of Object.keys(this.environmentMutations)) delete this.environmentMutations[k];
    this.testRecorder.reset();
    this.scriptWrittenVars.clear();
    this.scopeBaseline = {
      collection: { ...this.collectionVars },
      globals: { ...this.globalVars },
    };
    // The whole eval() is timed: the sentinel reset and bindings below can run
    // getters/setters an earlier user script installed. Reset on every exit.
    this.evalStartTime = Date.now();
    this.evalInterrupted = false;
    let completion: { handle: QuickJSHandle; topLevelAwait: boolean } | undefined;
    try {
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
      if (!trimmedScript && !this.evalInterrupted) {
        return {
          success: true,
          logs: this.logs,
          errors: this.errors,
          variables: { ...this.envVars },
        };
      }

      if (!this.evalInterrupted) this.bindRequestResponse(vm, context);
      if (!this.evalInterrupted) {
        const { source, topLevelAwait } = this.userScriptSource(vm, trimmedScript);
        const result = vm.evalCode(source, 'user-script.js');
        if (result.error) {
          this.addLog('error', `Script execution error: ${this.describeError(vm, result.error)}`);
          result.error.dispose();
        } else {
          // A top-level-await script's completion is its async wrapper; any
          // other script's is its last expression, which may be a floating
          // promise (an async IIFE). Both are checked once the jobs drain.
          completion = { handle: result.value, topLevelAwait };
        }
      }
      // Drain microtasks the script queued (await / .then / promise chains):
      // pump QuickJS jobs, yield to the host so in-flight host Promises (e.g.
      // pm.sendRequest) resolve, and repeat until no host work is outstanding
      // OR the wall-clock deadline is hit. That guard is load-bearing: the
      // interrupt handler only fires while bytecode runs, and a script awaiting
      // a hung host promise runs none, so we flip `evalInterrupted` ourselves.
      const ceiling = this.executionCeilingMs();
      const deadline = this.evalStartTime + ceiling;
      this.drainJobs();
      while (this.pendingHostOps > 0 && !this.evalInterrupted) {
        if (Date.now() >= deadline) {
          this.evalInterrupted = true;
          break;
        }
        // Yield once to the host so any pending Promise.then() callbacks
        // attached by pm.sendRequest can fire. setImmediate isn't available
        // in browsers; setTimeout(0) is the portable equivalent.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        this.drainJobs();
      }
      if (completion && !this.evalInterrupted) this.reportCompletion(vm, completion);
      // An async `pm.test` still pending here can never settle: no host work is
      // outstanding to resolve it (or the deadline hit). Fail it rather than
      // report a pass for an assertion that never ran.
      this.testRecorder.failPending(
        this.evalInterrupted ? `Test timed out after ${ceiling}ms` : 'Test promise never settled',
        { timedOut: this.evalInterrupted }
      );
      if (this.evalInterrupted) {
        this.addLog('error', `Script execution timed out after ${ceiling}ms`);
        this.errors.push(`Script execution timed out after ${ceiling}ms`);
        // Reject + dispose any still-pending host-promise deferreds. The
        // host-side Promises they wrap are still running (we can't cancel
        // an arbitrary host promise), but their QuickJS-side deferred is
        // freed so the runtime can be disposed cleanly. The host promise's
        // own .then/.catch/.finally will short-circuit on `!this.runtime`
        // once it eventually settles.
        this.releasePendingHostOps();
      }

      // Harvest the per-eval sentinels back into the result shape. Both are
      // optional — absent when the script didn't touch them. We tolerate
      // malformed JSON silently because the bootstrap above writes well-formed
      // values; a parse error here would mean a user script tampered with the
      // sentinel global, in which case "ignore and move on" matches Postman's
      // permissive behaviour.
      const execution = this.readExecutionSentinel(vm);
      const visualization = this.readVisualizationSentinel(vm);
      const requestMetadata = readRequestMetadata(vm, context.request);
      const requestHeaders = readRequestHeaders(vm, context.request);

      const hasGlobalsMutations = Object.keys(this.globalsMutations).length > 0;
      const hasCollectionMutations = Object.keys(this.collectionMutations).length > 0;
      const hasEnvironmentMutations = Object.keys(this.environmentMutations).length > 0;

      return {
        success: this.errors.length === 0,
        logs: this.logs,
        errors: this.errors,
        variables: { ...this.envVars },
        ...(this.tests.length > 0 && { tests: this.tests }),
        ...(hasGlobalsMutations && { globalsMutations: { ...this.globalsMutations } }),
        ...(hasCollectionMutations && { collectionMutations: { ...this.collectionMutations } }),
        ...(hasEnvironmentMutations && {
          environmentMutations: { ...this.environmentMutations },
        }),
        ...(execution && { execution }),
        ...(visualization && { visualization }),
        ...(requestMetadata && { requestMetadata }),
        ...(requestHeaders && { requestHeaders }),
      };
    } finally {
      if (completion?.handle.alive) completion.handle.dispose();
      this.evalStartTime = 0;
    }
  }

  /**
   * The source to evaluate. A script with a top-level `await` (a SyntaxError
   * in global code) runs as the body of an async function, opened on the
   * script's first line so line numbers stay the same; its `var` and function
   * declarations are then local to the script, which a one-shot run cannot
   * tell apart. Every other script, including one that does not compile at
   * all, is evaluated exactly as written.
   */
  private userScriptSource(
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
   * Report how the script's completion promise ended. A rejected top-level
   * await is a script error, as is a rejected promise the script left as its
   * last expression (an unhandled async IIFE); a top-level await that never
   * settled means the rest of the script never ran.
   *
   * QuickJS's host rejection tracker is not exposed by quickjs-emscripten, so
   * a rejected promise the script dropped anywhere else goes unreported.
   */
  private reportCompletion(
    vm: QuickJSContext,
    completion: { handle: QuickJSHandle; topLevelAwait: boolean }
  ): void {
    const state = vm.getPromiseState(completion.handle);
    if (state.type === 'rejected') {
      const message = this.describeError(vm, state.error);
      state.error.dispose();
      this.addLog(
        'error',
        completion.topLevelAwait
          ? `Script execution error: ${message}`
          : `Unhandled promise rejection: ${message}`
      );
      return;
    }
    if (state.type === 'pending') {
      if (completion.topLevelAwait) {
        this.addLog(
          'error',
          'Script execution error: a top-level await never settled, so the rest of the script did not run'
        );
      }
      return;
    }
    if (!state.notAPromise) state.value.dispose();
  }

  /** The same text a synchronous script error has always been reported with. */
  private describeError(vm: QuickJSContext, handle: QuickJSHandle): string {
    const errorValue = vm.dump(handle);
    return typeof errorValue === 'string' ? errorValue : JSON.stringify(errorValue);
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
    this.pushLog(type, message);
    if (type === 'error') {
      this.errors.push(message);
    }
  }

  /** A console line that is not a script error (a failed `pm.test` line). */
  private pushLog(type: 'log' | 'error' | 'warn' | 'info', message: string) {
    this.logs.push({
      type,
      message,
      timestamp: Date.now(),
    });
  }

  /**
   * `pm.variables.get`: Postman precedence, local > iteration data >
   * environment > collection > globals. `envVars` is the host's merged map (it
   * already layers those scopes), so it answers first, except where this
   * script wrote a lower scope and the merged value is that scope's own stale
   * value (it equals the scope's value when the eval started).
   */
  private resolveVariable(key: string): string | undefined {
    if (hasOwnKey(this.envVars, key)) {
      const merged = this.envVars[key];
      if (this.scriptWrittenVars.has(key)) return merged;
      const fromCollection = hasOwnKey(this.scopeBaseline.collection, key);
      if (
        hasOwnKey(this.collectionMutations, key) &&
        fromCollection &&
        this.scopeBaseline.collection[key] === merged
      ) {
        return readOwnKey(this.collectionVars, key) ?? readOwnKey(this.globalVars, key);
      }
      if (
        !fromCollection &&
        hasOwnKey(this.globalsMutations, key) &&
        readOwnKey(this.scopeBaseline.globals, key) === merged
      ) {
        return readOwnKey(this.globalVars, key);
      }
      return merged;
    }
    if (this.scriptWrittenVars.has(key)) {
      // Unset in this script's environment / local scope: lower scopes show through.
      return readOwnKey(this.collectionVars, key) ?? readOwnKey(this.globalVars, key);
    }
    return (
      readOwnKey(this.iterationData, key) ??
      readOwnKey(this.collectionVars, key) ??
      readOwnKey(this.globalVars, key)
    );
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
    const envObj = buildKvNamespace(vm, this.envVars, this.environmentMutations, {
      onWrite: (key) => this.scriptWrittenVars.add(key),
    });
    vm.setProp(vm.global, 'environment', envObj);
    envObj.dispose();

    const globalsObj = buildKvNamespace(vm, this.globalVars);
    vm.setProp(vm.global, 'globals', globalsObj);
    globalsObj.dispose();

    // Setup pm (Postman-compatible) API
    const pmObj = vm.newObject();

    // pm.test natives; the JS wrapper is installed once `pm` is global.
    this.testRecorder.bindNatives(vm);

    // pm.variables / pm.globals / pm.environment / pm.collectionVariables —
    // four Postman namespaces. `pm.variables` aliases `pm.environment` (the
    // active resolution scope at the script's request). `pm.collectionVariables`
    // uses the dedicated collectionVars map when supplied via fromOptions,
    // and aliases envVars when the legacy positional constructor is used.
    //
    // Mutation trackers are wired for `globals`, `environment` and
    // `collectionVariables` (the scopes hosts persist). `pm.variables` shares
    // the request's variable map with `pm.environment` (both show up in
    // `result.variables` for the rest of the request), but only
    // `pm.environment` writes are reported for persisting, as in Postman.
    // `pm.variables.get/has` resolve across every scope (Postman precedence).
    const markWritten = (key: string) => this.scriptWrittenVars.add(key);
    const kvBindings: Array<
      [
        string,
        Record<string, string>,
        Record<string, string | null> | undefined,
        Parameters<typeof buildKvNamespace>[3],
      ]
    > = [
      [
        'variables',
        this.envVars,
        undefined,
        { read: (key) => this.resolveVariable(key), onWrite: markWritten },
      ],
      ['globals', this.globalVars, this.globalsMutations, {}],
      ['environment', this.envVars, this.environmentMutations, { onWrite: markWritten }],
      ['collectionVariables', this.collectionVars, this.collectionMutations, {}],
    ];
    for (const [name, map, mutations, options] of kvBindings) {
      const ns = buildKvNamespace(vm, map, mutations, options);
      vm.setProp(pmObj, name, ns);
      ns.dispose();
    }

    // pm.iterationData — real backing map (empty for non-runner calls).
    // Same get/set/unset/has surface as the other pm.* namespaces, plus
    // toObject() for Postman compatibility.
    const pmIterData = buildKvNamespace(vm, this.iterationData);
    const pmIterToObject = vm.newFunction('toObject', () => {
      return makeJSValue(vm, { ...this.iterationData });
    });
    vm.setProp(pmIterData, 'toObject', pmIterToObject);
    vm.setProp(pmObj, 'iterationData', pmIterData);
    pmIterToObject.dispose();
    pmIterData.dispose();

    // pm.cookies — read/write the renderer's persistent cookie jar.
    // Per-eval `bindRequestResponse` overwrites `this.callCookieAdapter`
    // so `pm.cookies.get(name)` resolves against the active request URL.
    bindPmCookies(vm, pmObj, () => this.callCookieAdapter);

    // pm.sendRequest — bound on every host (rejects clearly without one);
    // its Postman surface is installed by SEND_REQUEST_WRAPPER below.
    this.bindPmSendRequest(vm, pmObj);

    // rs.judge — LLM-as-judge semantic assertion. Bound unconditionally
    // (like pm.vault): when no host.judge closure is wired (web build / CLI
    // without an AI provider) each call rejects with a clean "not wired in"
    // error so scripts fail loudly rather than throwing "not a function".
    // Available as both pm.judge and rs.judge (same object).
    this.bindPmJudge(vm, pmObj);

    // pm.vault — async key-value secret store. Each method returns a
    // QuickJS Promise that resolves when the host async work (IPC →
    // electron-store on desktop, rejection on web) completes. Bound
    // unconditionally; if no host.vault is wired in, each method
    // rejects with a clean "no adapter" error so scripts fail loudly
    // rather than hanging.
    this.bindPmVault(vm, pmObj);

    // Put pm on the global BEFORE we eval any code that references it
    // (the pm.info default and PM_EXPECT_BOOTSTRAP both expect `pm` to exist).
    // `rs` is the native Restura namespace; `pm` is bound as a live alias to
    // the SAME object, so every later `pm.<anything> = …` / `rs.<anything>`
    // sees identical state — no dual-assignment needed at the call sites.
    // Dispose the local handle only after BOTH globals reference it — the
    // QuickJS GC keeps the underlying object alive via those references.
    vm.setProp(vm.global, 'pm', pmObj);
    vm.setProp(vm.global, 'rs', pmObj);
    pmObj.dispose();

    installPmTest(vm);

    // Errors the sandbox catches on the script's behalf (a throwing
    // pm.sendRequest callback) are script errors.
    const reportFn = vm.newFunction('reportScriptError', (messageHandle) => {
      this.addLog('error', vm.getString(messageHandle));
    });
    vm.setProp(vm.global, '__rs_reportScriptError', reportFn);
    reportFn.dispose();
    const wrapper = vm.evalCode(SEND_REQUEST_WRAPPER);
    if (wrapper.error) {
      this.addLog(
        'error',
        `Failed to setup pm.sendRequest: ${this.stringify(vm.dump(wrapper.error))}`
      );
      wrapper.error.dispose();
    } else {
      wrapper.value.dispose();
    }

    // pm.info — default empty; per-eval bindRequestResponse() overwrites with
    // the active request's name/id when available.
    const pmInfo = vm.evalCode(
      "pm.info = { requestName: '', requestId: '', iteration: 0, iterationCount: 1, eventName: '' };"
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

      // Legacy \`postman.*\` API — predates the \`pm.*\` namespace. Kept for
      // backward compatibility with older Postman scripts/collections; new
      // scripts should use \`pm.*\` (or \`rs.*\`) directly.
      globalThis.postman = {
        setEnvironmentVariable: function (key, value) { pm.environment.set(key, value); },
        getEnvironmentVariable: function (key) { return pm.environment.get(key); },
        clearEnvironmentVariable: function (key) { pm.environment.unset(key); },
        setGlobalVariable: function (key, value) { pm.globals.set(key, value); },
        getGlobalVariable: function (key) { return pm.globals.get(key); },
        clearGlobalVariable: function (key) { pm.globals.unset(key); },
        setNextRequest: function (name) { pm.execution.setNextRequest(name); },
      };

      // Legacy \`tests["assertion label"] = true/false;\` object-literal style
      // — predates \`pm.test(name, fn)\`. Every property assignment records a
      // pass/fail test with that label, exactly like Postman's original API.
      globalThis.tests = new Proxy({}, {
        set: function (target, prop, value) {
          var label = String(prop);
          var ok = Boolean(value);
          pm.test(label, function () {
            if (!ok) {
              var err = new Error('Test failed: ' + label);
              err.name = 'AssertionError';
              throw err;
            }
          });
          target[prop] = value;
          return true;
        },
      });
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
