// Scripting Sandbox for Pre-request and Test Scripts
// Provides a SECURE sandboxed environment using QuickJS for executing user scripts
// Security features: Memory limits, execution timeout, no filesystem/network access

import type {
  QuickJSContext,
  QuickJSHandle,
  QuickJSRuntime,
} from 'quickjs-emscripten';
import { getQuickJS } from 'quickjs-emscripten';
import { PM_EXPECT_CODE } from './chaiSubset';

export interface PmRequestInfo {
  requestName?: string;
  requestId?: string;
  iteration?: number;
  iterationCount?: number;
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
}

// Security constants
const MAX_EXECUTION_TIME_MS = 5000; // 5 second timeout
const MAX_MEMORY_BYTES = 10 * 1024 * 1024; // 10MB memory limit

class ScriptExecutor {
  private envVars: Record<string, string> = {};
  private globalVars: Record<string, string> = {};
  private logs: ScriptResult['logs'] = [];
  private errors: string[] = [];
  private tests: Array<{ name: string; passed: boolean; error?: string }> = [];

  // QuickJS lifecycle. `initialize()` populates these once; `eval()` reuses
  // them across many calls; `dispose()` tears down. The one-shot
  // `executeScript()` path brackets initialize + eval + dispose in a single
  // call, preserving its existing semantics.
  private runtime: QuickJSRuntime | null = null;
  private vm: QuickJSContext | null = null;
  private evalStartTime = 0;
  private evalInterrupted = false;

  constructor(envVars: Record<string, string> = {}, globalVars: Record<string, string> = {}) {
    this.envVars = { ...envVars };
    this.globalVars = { ...globalVars };
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
      if (Date.now() - this.evalStartTime > MAX_EXECUTION_TIME_MS) {
        this.evalInterrupted = true;
        return true;
      }
      return false;
    });
    const vm = runtime.newContext();
    this.runtime = runtime;
    this.vm = vm;
    // Bind console / environment / globals / pm.* and evaluate the
    // utils + expect helpers. Request/response are bound per-eval below.
    this.setupQuickJSContext(vm, {});
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
   * Bind `request`, `response`, and `pm.info` globals from `context` onto the
   * VM. Called by `eval()` per-invocation — the previous handle is
   * garbage-collected by QuickJS when overwritten.
   */
  private bindRequestResponse(
    vm: QuickJSContext,
    context: {
      request?: ScriptContext['request'];
      response?: ScriptContext['response'];
      info?: PmRequestInfo;
    }
  ): void {
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
    if (context.info) {
      // Bind into pm.info — pm itself is already on the global, set via
      // an eval so we can reach pm.info.requestName etc. with normal
      // property-set semantics rather than another setProp chain.
      const payload = JSON.stringify({
        requestName: context.info.requestName ?? '',
        requestId: context.info.requestId ?? '',
        iteration: context.info.iteration ?? 0,
        iterationCount: context.info.iterationCount ?? 1,
      });
      const r = vm.evalCode(`pm.info = ${payload};`);
      if (r.error) r.error.dispose();
      else r.value.dispose();
    }
  }

  /**
   * Build a QuickJS object exposing get/set/unset/has against a live
   * Record<string,string>. Mutations go straight to the backing map; the
   * caller is responsible for setProp-ing it under the right name and
   * disposing the returned handle.
   *
   * Shared by `environment`, `globals`, and the four `pm.*` namespaces —
   * keeping the binding logic in one place means new behaviour (e.g.
   * change-notification) only needs to land here.
   */
  private buildKvNamespace(vm: QuickJSContext, store: Record<string, string>): QuickJSHandle {
    const ns = vm.newObject();
    const get = vm.newFunction('get', (keyHandle) => {
      const key = vm.getString(keyHandle);
      const value = store[key];
      return value !== undefined ? vm.newString(value) : vm.undefined;
    });
    const set = vm.newFunction('set', (keyHandle, valueHandle) => {
      store[vm.getString(keyHandle)] = vm.getString(valueHandle);
    });
    const unset = vm.newFunction('unset', (keyHandle) => {
      delete store[vm.getString(keyHandle)];
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
    } = {}
  ): Promise<ScriptResult> {
    const vm = this.vm;
    if (!vm) {
      throw new Error('ScriptExecutor.eval called before initialize()');
    }

    this.logs = [];
    this.errors = [];
    this.tests = [];

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

    const result = vm.evalCode(trimmedScript, 'user-script.js', {
      strict: true,
    });
    if (result.error) {
      const errorValue = vm.dump(result.error);
      const errorMsg = typeof errorValue === 'string' ? errorValue : JSON.stringify(errorValue);
      this.addLog('error', `Script execution error: ${errorMsg}`);
      result.error.dispose();
    } else {
      result.value.dispose();
    }
    if (this.evalInterrupted) {
      this.addLog('error', `Script execution timed out after ${MAX_EXECUTION_TIME_MS}ms`);
      this.errors.push(`Script execution timed out after ${MAX_EXECUTION_TIME_MS}ms`);
    }

    return {
      success: this.errors.length === 0,
      logs: this.logs,
      errors: this.errors,
      variables: { ...this.envVars },
      ...(this.tests.length > 0 && { tests: this.tests }),
    };
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
    // four Postman namespaces, all wrapping a Record<string,string> with the
    // same get/set/unset/has shape. `collectionVariables` shares the envVars
    // store in v1 (matches Postman's resolution chain); a later change can
    // split workspace vs. collection-scoped storage.
    for (const [name, map] of [
      ['variables', this.envVars],
      ['globals', this.globalVars],
      ['environment', this.envVars],
      ['collectionVariables', this.envVars],
    ] as const) {
      const ns = this.buildKvNamespace(vm, map);
      vm.setProp(pmObj, name, ns);
      ns.dispose();
    }

    // pm.iterationData — empty stub for v1 (the runner doesn't yet drive
    // data-file iteration). Scripts that call .get() get undefined back,
    // which matches Postman's behaviour for an unbound variable.
    const pmIterData = vm.newObject();
    const pmIterGet = vm.newFunction('get', () => vm.undefined);
    const pmIterToObject = vm.newFunction('toObject', () => vm.newObject());
    vm.setProp(pmIterData, 'get', pmIterGet);
    vm.setProp(pmIterData, 'toObject', pmIterToObject);
    vm.setProp(pmObj, 'iterationData', pmIterData);
    pmIterGet.dispose();
    pmIterToObject.dispose();
    pmIterData.dispose();

    // Setup pm.expect and pm.response as helper functions
    // Inject utility helpers — date, random, encoding
    const utilsCode = `
      // pm.utils — helpers for scripts
      pm.utils = {
        // Date helpers
        timestamp: function() { return Date.now(); },
        isoDate: function() { return new Date().toISOString(); },
        // Random helpers
        randomInt: function(min, max) {
          min = min === undefined ? 0 : min;
          max = max === undefined ? 1000000 : max;
          return Math.floor(Math.random() * (max - min + 1)) + min;
        },
        randomFloat: function(min, max) {
          min = min === undefined ? 0 : min;
          max = max === undefined ? 1 : max;
          return Math.random() * (max - min) + min;
        },
        randomChoice: function(arr) {
          if (!arr || arr.length === 0) return undefined;
          return arr[Math.floor(Math.random() * arr.length)];
        },
        // Encoding helpers
        btoa: function(str) {
          var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
          var out = '';
          for (var i = 0; i < str.length; ) {
            var c1 = str.charCodeAt(i++);
            var c2 = i < str.length ? str.charCodeAt(i++) : 0;
            var c3 = i < str.length ? str.charCodeAt(i++) : 0;
            out += chars[(c1 >> 2)];
            out += chars[((c1 & 3) << 4) | (c2 >> 4)];
            out += chars[((c2 & 0xf) << 2) | (c3 >> 6)];
            out += chars[c3 & 0x3f];
          }
          if (str.length % 3 === 1) { out = out.slice(0, -2) + '=='; }
          else if (str.length % 3 === 2) { out = out.slice(0, -1) + '='; }
          return out;
        },
        atob: function(str) {
          var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
          str = str.replace(/=+$/, '');
          var out = '';
          for (var i = 0; i < str.length; ) {
            var b1 = chars.indexOf(str[i++]);
            var b2 = chars.indexOf(str[i++]);
            var b3 = chars.indexOf(str[i++]);
            var b4 = chars.indexOf(str[i++]);
            out += String.fromCharCode((b1 << 2) | (b2 >> 4));
            if (b3 < 64) out += String.fromCharCode(((b2 & 0xf) << 4) | (b3 >> 2));
            if (b4 < 64) out += String.fromCharCode(((b3 & 3) << 6) | b4);
          }
          return out;
        },
        // Simple URL encode/decode
        encodeURIComponent: function(str) {
          return encodeURIComponent ? encodeURIComponent(str) : str;
        },
        decodeURIComponent: function(str) {
          return decodeURIComponent ? decodeURIComponent(str) : str;
        },
        // UUID/GUID generator (RFC 4122 v4)
        uuid: function() {
          var t = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
          return t.replace(/[xy]/g, function(c) {
            var r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
          });
        },
        // Simple hash (djb2) — not cryptographic, for script use only
        hash: function(str) {
          var h = 5381;
          for (var i = 0; i < str.length; i++) {
            h = ((h << 5) + h) ^ str.charCodeAt(i);
          }
          return (h >>> 0).toString(16);
        },
      };
      // Dynamic variables (Postman-style)
      pm.variables.randomInt = function() { return pm.utils.randomInt(0, 1000000); };
      pm.variables.timestamp = function() { return pm.utils.timestamp(); };
      pm.variables.guid = function() { return pm.utils.uuid(); };
      pm.variables.uuid = function() { return pm.utils.uuid(); };
    `;

    const utilsResult = vm.evalCode(utilsCode);
    if (utilsResult.error) {
      utilsResult.error.dispose();
    } else {
      utilsResult.value.dispose();
    }

    // Put pm on the global BEFORE we eval any code that references it
    // (the pm.info default and PM_EXPECT_CODE both expect `pm` to exist).
    vm.setProp(vm.global, 'pm', pmObj);

    // pm.info — default empty; per-eval bindRequestResponse() overwrites with
    // the active request's name/id when available.
    const pmInfo = vm.evalCode(
      "pm.info = { requestName: '', requestId: '', iteration: 0, iterationCount: 1 };"
    );
    if (pmInfo.error) pmInfo.error.dispose();
    else pmInfo.value.dispose();

    // Evaluate the expect / response setup code (imported from chaiSubset.ts).
    const setupResult = vm.evalCode(PM_EXPECT_CODE);
    if (setupResult.error) {
      const errorMsg = vm.dump(setupResult.error);
      this.addLog('error', `Failed to setup pm API: ${errorMsg}`);
      setupResult.error.dispose();
    } else {
      setupResult.value.dispose();
    }

    vm.setProp(vm.global, 'pm', pmObj);
    pmObj.dispose();

    // Hoppscotch compatibility: their scripts use `pw.*` (legacy v0-v11) and
    // `hopp.*` (v12+) instead of `pm.*`. Both are aliased to the same `pm`
    // surface as a best-effort. Some methods diverge slightly between
    // hopp/pm (e.g. response.to.have.status signatures); imported scripts
    // may need manual review.
    const aliasResult = vm.evalCode('globalThis.pw = pm; globalThis.hopp = pm;');
    if (aliasResult.error) {
      aliasResult.error.dispose();
    } else {
      aliasResult.value.dispose();
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
