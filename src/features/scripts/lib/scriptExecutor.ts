// Scripting Sandbox for Pre-request and Test Scripts
// Provides a SECURE sandboxed environment using QuickJS for executing user scripts
// Security features: Memory limits, execution timeout, no filesystem/network access

import { getQuickJS, QuickJSContext, QuickJSHandle } from 'quickjs-emscripten';

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

  constructor(envVars: Record<string, string> = {}, globalVars: Record<string, string> = {}) {
    this.envVars = { ...envVars };
    this.globalVars = { ...globalVars };
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
    this.tests.push({ name, passed, error });
    if (passed) {
      this.addLog('info', `✓ ${name}`);
    } else {
      this.addLog('error', `✗ ${name}: ${error || 'Test failed'}`);
    }
  }

  // Setup QuickJS context with sandboxed APIs
  private setupQuickJSContext(
    vm: QuickJSContext,
    context: {
      request?: ScriptContext['request'];
      response?: ScriptContext['response'];
    }
  ): void {
    // Helper to create JS value from native
    const toJSValue = (value: unknown): QuickJSHandle => {
      if (value === undefined) return vm.undefined;
      if (value === null) return vm.null;
      if (typeof value === 'boolean') return value ? vm.true : vm.false;
      if (typeof value === 'number') return vm.newNumber(value);
      if (typeof value === 'string') return vm.newString(value);
      if (Array.isArray(value)) {
        const arr = vm.newArray();
        value.forEach((item, i) => {
          const itemHandle = toJSValue(item);
          vm.setProp(arr, i, itemHandle);
          itemHandle.dispose();
        });
        return arr;
      }
      if (typeof value === 'object') {
        const obj = vm.newObject();
        for (const [key, val] of Object.entries(value)) {
          const valHandle = toJSValue(val);
          vm.setProp(obj, key, valHandle);
          valHandle.dispose();
        }
        return obj;
      }
      return vm.undefined;
    };

    // Helper to convert QuickJS value to native
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

    // Setup request object (read-only)
    if (context.request) {
      const requestHandle = toJSValue(context.request);
      vm.setProp(vm.global, 'request', requestHandle);
      requestHandle.dispose();
    }

    // Setup response object (read-only)
    if (context.response) {
      const responseHandle = toJSValue(context.response);
      vm.setProp(vm.global, 'response', responseHandle);
      responseHandle.dispose();
    }

    // Setup environment object
    const envObj = vm.newObject();
    const envGetFn = vm.newFunction('get', (keyHandle) => {
      const key = vm.getString(keyHandle);
      const value = this.envVars[key];
      return value !== undefined ? vm.newString(value) : vm.undefined;
    });
    const envSetFn = vm.newFunction('set', (keyHandle, valueHandle) => {
      const key = vm.getString(keyHandle);
      const value = vm.getString(valueHandle);
      this.envVars[key] = value;
    });
    vm.setProp(envObj, 'get', envGetFn);
    vm.setProp(envObj, 'set', envSetFn);
    vm.setProp(vm.global, 'environment', envObj);
    envGetFn.dispose();
    envSetFn.dispose();
    envObj.dispose();

    // Setup globals object
    const globalsObj = vm.newObject();
    const globalsGetFn = vm.newFunction('get', (keyHandle) => {
      const key = vm.getString(keyHandle);
      const value = this.globalVars[key];
      return value !== undefined ? vm.newString(value) : vm.undefined;
    });
    const globalsSetFn = vm.newFunction('set', (keyHandle, valueHandle) => {
      const key = vm.getString(keyHandle);
      const value = vm.getString(valueHandle);
      this.globalVars[key] = value;
    });
    vm.setProp(globalsObj, 'get', globalsGetFn);
    vm.setProp(globalsObj, 'set', globalsSetFn);
    vm.setProp(vm.global, 'globals', globalsObj);
    globalsGetFn.dispose();
    globalsSetFn.dispose();
    globalsObj.dispose();

    // Setup pm (Postman-compatible) API
    const pmObj = vm.newObject();

    // pm.test
    const testFn = vm.newFunction('test', (nameHandle, fnHandle) => {
      const name = vm.getString(nameHandle);
      try {
        const result = vm.callFunction(fnHandle, vm.undefined);
        if (result.error) {
          const errorMsg = vm.dump(result.error);
          this.addTest(name, false, String(errorMsg));
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

    // pm.variables
    const variablesObj = vm.newObject();
    const varGetFn = vm.newFunction('get', (keyHandle) => {
      const key = vm.getString(keyHandle);
      const value = this.envVars[key];
      return value !== undefined ? vm.newString(value) : vm.undefined;
    });
    const varSetFn = vm.newFunction('set', (keyHandle, valueHandle) => {
      const key = vm.getString(keyHandle);
      const value = vm.getString(valueHandle);
      this.envVars[key] = value;
    });
    vm.setProp(variablesObj, 'get', varGetFn);
    vm.setProp(variablesObj, 'set', varSetFn);
    vm.setProp(pmObj, 'variables', variablesObj);
    varGetFn.dispose();
    varSetFn.dispose();
    variablesObj.dispose();

    // pm.globals
    const pmGlobalsObj = vm.newObject();
    const pmGlobalsGetFn = vm.newFunction('get', (keyHandle) => {
      const key = vm.getString(keyHandle);
      const value = this.globalVars[key];
      return value !== undefined ? vm.newString(value) : vm.undefined;
    });
    const pmGlobalsSetFn = vm.newFunction('set', (keyHandle, valueHandle) => {
      const key = vm.getString(keyHandle);
      const value = vm.getString(valueHandle);
      this.globalVars[key] = value;
    });
    vm.setProp(pmGlobalsObj, 'get', pmGlobalsGetFn);
    vm.setProp(pmGlobalsObj, 'set', pmGlobalsSetFn);
    vm.setProp(pmObj, 'globals', pmGlobalsObj);
    pmGlobalsGetFn.dispose();
    pmGlobalsSetFn.dispose();
    pmGlobalsObj.dispose();

    // Setup pm.expect and pm.response as helper functions
    const expectCode = `
      pm.expect = function(actual) {
        return {
          to: {
            equal: function(expected) {
              if (JSON.stringify(actual) !== JSON.stringify(expected)) {
                throw new Error('Expected ' + JSON.stringify(expected) + ' but got ' + JSON.stringify(actual));
              }
            },
            be: {
              a: function(type) {
                var actualType = Array.isArray(actual) ? 'array' : typeof actual;
                if (actualType !== type.toLowerCase()) {
                  throw new Error('Expected type ' + type + ' but got ' + actualType);
                }
              },
              true: function() {
                if (actual !== true) {
                  throw new Error('Expected true but got ' + JSON.stringify(actual));
                }
              },
              false: function() {
                if (actual !== false) {
                  throw new Error('Expected false but got ' + JSON.stringify(actual));
                }
              }
            },
            have: {
              property: function(prop) {
                if (typeof actual !== 'object' || actual === null || !(prop in actual)) {
                  throw new Error('Expected object to have property "' + prop + '"');
                }
              },
              length: function(len) {
                if (typeof actual !== 'object' || actual === null || !('length' in actual)) {
                  throw new Error('Expected value to have length property');
                }
                if (actual.length !== len) {
                  throw new Error('Expected length ' + len + ' but got ' + actual.length);
                }
              }
            }
          }
        };
      };

      pm.response = {
        to: {
          have: {
            status: function(code) {
              if (typeof response === 'undefined' || response.status !== code) {
                throw new Error('Expected status ' + code + ' but got ' + (response ? response.status : 'undefined'));
              }
            },
            header: function(key, value) {
              if (typeof response === 'undefined') throw new Error('No response available');
              var headerValue = response.headers[key] || response.headers[key.toLowerCase()];
              if (!headerValue) {
                throw new Error('Expected header "' + key + '" to exist');
              }
              if (value !== undefined && headerValue !== value) {
                throw new Error('Expected header "' + key + '" to be "' + value + '" but got "' + headerValue + '"');
              }
            },
            body: function(value) {
              if (typeof response === 'undefined' || !response.body) {
                throw new Error('Expected response to have body');
              }
              if (value !== undefined && JSON.stringify(response.body) !== JSON.stringify(value)) {
                throw new Error('Expected body to be ' + JSON.stringify(value) + ' but got ' + JSON.stringify(response.body));
              }
            },
            jsonBody: function(path, value) {
              if (typeof response === 'undefined' || !response.body) {
                throw new Error('Expected response to have JSON body');
              }
              if (path) {
                var parts = path.split('.');
                var current = response.body;
                for (var i = 0; i < parts.length; i++) {
                  if (current === null || typeof current !== 'object') {
                    throw new Error('Cannot access path ' + path);
                  }
                  current = current[parts[i]];
                }
                if (value !== undefined && JSON.stringify(current) !== JSON.stringify(value)) {
                  throw new Error('Expected ' + path + ' to be ' + JSON.stringify(value) + ' but got ' + JSON.stringify(current));
                }
              }
            }
          },
          be: {
            ok: function() {
              if (typeof response === 'undefined' || response.status < 200 || response.status >= 300) {
                throw new Error('Expected successful status but got ' + (response ? response.status : 'undefined'));
              }
            },
            json: function() {
              if (typeof response === 'undefined' || typeof response.body !== 'object') {
                throw new Error('Expected response to be JSON');
              }
            },
            html: function() {
              if (typeof response === 'undefined') throw new Error('No response available');
              var contentType = response.headers['content-type'] || response.headers['Content-Type'];
              if (!contentType || contentType.indexOf('text/html') === -1) {
                throw new Error('Expected response to be HTML');
              }
            }
          }
        },
        time: {
          below: function(ms) {
            if (typeof response === 'undefined' || response.time >= ms) {
              throw new Error('Expected response time below ' + ms + 'ms but got ' + (response ? response.time : 'undefined') + 'ms');
            }
          }
        }
      };
    `;

    // Evaluate the expect/response setup code
    const setupResult = vm.evalCode(expectCode);
    if (setupResult.error) {
      const errorMsg = vm.dump(setupResult.error);
      this.addLog('error', `Failed to setup pm API: ${errorMsg}`);
      setupResult.error.dispose();
    } else {
      setupResult.value.dispose();
    }

    vm.setProp(vm.global, 'pm', pmObj);
    pmObj.dispose();
  }

  async executeScript(
    script: string,
    context: {
      request?: ScriptContext['request'];
      response?: ScriptContext['response'];
    }
  ): Promise<ScriptResult> {
    // Reset state
    this.logs = [];
    this.errors = [];
    this.tests = [];

    // Validate script input
    if (!script || typeof script !== 'string') {
      return {
        success: true,
        logs: this.logs,
        errors: this.errors,
        variables: { ...this.envVars },
        tests: undefined,
      };
    }

    // Trim and check for empty script
    const trimmedScript = script.trim();
    if (!trimmedScript) {
      return {
        success: true,
        logs: this.logs,
        errors: this.errors,
        variables: { ...this.envVars },
        tests: undefined,
      };
    }

    // Security: Basic script validation to catch obvious attack patterns
    const dangerousPatterns = [
      /\beval\s*\(/,
      /\bFunction\s*\(/,
      /\b__proto__\b/,
      /\bconstructor\s*\[/,
      /\bObject\.prototype\b/,
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(trimmedScript)) {
        this.addLog('error', `Script contains potentially dangerous pattern: ${pattern.source}`);
        return {
          success: false,
          logs: this.logs,
          errors: ['Script contains blocked patterns'],
          variables: { ...this.envVars },
          tests: undefined,
        };
      }
    }

    try {
      // Initialize QuickJS runtime with security constraints
      const QuickJS = await getQuickJS();
      const runtime = QuickJS.newRuntime();

      // Set memory limit (10MB)
      runtime.setMemoryLimit(MAX_MEMORY_BYTES);

      // Set execution timeout
      const startTime = Date.now();
      let interrupted = false;

      runtime.setInterruptHandler(() => {
        const elapsed = Date.now() - startTime;
        if (elapsed > MAX_EXECUTION_TIME_MS) {
          interrupted = true;
          return true; // Interrupt execution
        }
        return false; // Continue execution
      });

      const vm = runtime.newContext();

      try {
        // Setup the sandboxed environment
        this.setupQuickJSContext(vm, context);

        // Execute the user script in strict mode
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

        if (interrupted) {
          this.addLog('error', `Script execution timed out after ${MAX_EXECUTION_TIME_MS}ms`);
          this.errors.push(`Script execution timed out after ${MAX_EXECUTION_TIME_MS}ms`);
        }
      } finally {
        vm.dispose();
        runtime.dispose();
      }

      return {
        success: this.errors.length === 0,
        logs: this.logs,
        errors: this.errors,
        variables: { ...this.envVars },
        tests: this.tests.length > 0 ? this.tests : undefined,
      };
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
        tests: this.tests.length > 0 ? this.tests : undefined,
      };
    }
  }
}

export default ScriptExecutor;
