import type { QuickJSContext } from 'quickjs-emscripten';

type TestEntry = { name: string; passed: boolean; error?: string };
/**
 * Writes a console line only. A failed test is reported on its test entry, so
 * its `✗ name: reason` line must not also land in the script's `errors` (it
 * would read as a script error, and fail a run that only asserted).
 */
type Log = (type: 'info' | 'error', message: string) => void;

/**
 * `pm.test` outcomes in call order. A test is reserved before its callback
 * runs, so an async test that settles later keeps its place in the report;
 * a test still pending when the eval ends is failed, never reported as passed.
 */
export class PmTestRecorder {
  private readonly pending = new Set<number>();
  /** Slots of `pm.test(name, function (done) {...})` tests. */
  private readonly doneStyle = new Set<number>();
  /** The last assertion that failed outside any synchronous `pm.test` body. */
  private escapedFailure: string | undefined;
  private readonly tests: () => TestEntry[];
  private readonly log: Log;

  constructor(tests: () => TestEntry[], log: Log) {
    this.tests = tests;
    this.log = log;
  }

  reset(): void {
    this.pending.clear();
    this.doneStyle.clear();
    this.escapedFailure = undefined;
  }

  reserve(name: string, options: { done?: boolean } = {}): number {
    const tests = this.tests();
    tests.push({ name, passed: false });
    const slot = tests.length - 1;
    this.pending.add(slot);
    if (options.done) this.doneStyle.add(slot);
    return slot;
  }

  settle(slot: number, passed: boolean, error?: string): void {
    if (!this.pending.delete(slot)) return;
    this.doneStyle.delete(slot);
    const test = this.tests()[slot];
    if (!test) return;
    test.passed = passed;
    if (passed) {
      this.log('info', `✓ ${test.name}`);
    } else {
      test.error = error || 'Test failed';
      this.log('error', `✗ ${test.name}: ${test.error}`);
    }
  }

  /**
   * An assertion failed outside a synchronous test body (in a `.then` or a
   * sub-request callback): a `done`-style test that never completes reports it.
   */
  noteEscapedFailure(message: string): void {
    this.escapedFailure = message;
  }

  /**
   * Fail every test whose promise never settled (nothing left to resolve it).
   * A `done`-style test that is not timed out says done() was never called,
   * with the assertion that most likely stopped it.
   */
  failPending(message: string, options: { timedOut?: boolean } = {}): void {
    for (const slot of [...this.pending]) {
      if (this.doneStyle.has(slot) && !options.timedOut) {
        this.settle(slot, false, this.escapedFailure ?? 'done() was never called');
      } else {
        this.settle(slot, false, message);
      }
    }
  }

  /** Expose reserve/settle to the sandbox for {@link installPmTest}. */
  bindNatives(vm: QuickJSContext): void {
    const reserveFn = vm.newFunction('reserveTest', (nameHandle, doneHandle) =>
      vm.newNumber(
        this.reserve(vm.getString(nameHandle), {
          done: doneHandle !== undefined && vm.dump(doneHandle) === true,
        })
      )
    );
    const settleFn = vm.newFunction('settleTest', (slotHandle, passedHandle, errorHandle) => {
      const error =
        errorHandle && vm.typeof(errorHandle) === 'string' ? vm.getString(errorHandle) : undefined;
      this.settle(vm.getNumber(slotHandle), vm.dump(passedHandle) === true, error);
    });
    const escapedFn = vm.newFunction('noteEscapedFailure', (messageHandle) => {
      this.noteEscapedFailure(vm.getString(messageHandle));
    });
    vm.setProp(vm.global, '__pm_reserveTest', reserveFn);
    vm.setProp(vm.global, '__pm_settleTest', settleFn);
    vm.setProp(vm.global, '__pm_noteEscapedFailure', escapedFn);
    reserveFn.dispose();
    settleFn.dispose();
    escapedFn.dispose();
  }
}

/**
 * Install `pm.test(name, fn)` (after `pm` is global): a thrown error or a
 * rejected returned promise fails the test; a returned promise is awaited
 * within the script's timeout. A callback that declares a parameter gets
 * Postman's `done(err?)` and the test settles when it is called.
 */
export function installPmTest(vm: QuickJSContext): void {
  const result = vm.evalCode(`(function () {
    var reserve = globalThis.__pm_reserveTest;
    var settle = globalThis.__pm_settleTest;
    var noteEscaped = globalThis.__pm_noteEscapedFailure;
    delete globalThis.__pm_reserveTest;
    delete globalThis.__pm_settleTest;
    delete globalThis.__pm_noteEscapedFailure;
    function message(e) {
      if (e && typeof e === 'object' && 'message' in e) return String(e.message);
      return String(e);
    }
    // Depth of synchronous pm.test bodies running now: an assertion failing at
    // depth 0 escaped a test (async continuation) and may explain a done() test
    // that never completes.
    var depth = 0;
    try {
      var Assertion = require('chai').Assertion;
      var assert = Assertion && Assertion.prototype && Assertion.prototype.assert;
      if (typeof assert === 'function') {
        Assertion.prototype.assert = function () {
          try {
            return assert.apply(this, arguments);
          } catch (e) {
            if (depth === 0) noteEscaped(message(e));
            throw e;
          }
        };
      }
    } catch (_e) {
      // No chai bundle: done() tests still fail, with a generic message.
    }
    pm.test = function (name, fn) {
      var wantsDone = typeof fn === 'function' && fn.length > 0;
      var slot = reserve(String(name), wantsDone);
      var returned;
      depth++;
      try {
        if (wantsDone) {
          returned = fn(function done(err) {
            if (err !== undefined && err !== null) settle(slot, false, message(err));
            else settle(slot, true);
          });
        } else {
          returned = fn();
        }
      } catch (e) {
        settle(slot, false, message(e));
        return;
      } finally {
        depth--;
      }
      if (returned && typeof returned.then === 'function') {
        returned.then(
          function () { if (!wantsDone) settle(slot, true); },
          function (e) { settle(slot, false, message(e)); }
        );
      } else if (!wantsDone) {
        settle(slot, true);
      }
    };
  })();`);
  if (result.error) result.error.dispose();
  else result.value.dispose();
}
