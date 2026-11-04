import type { QuickJSContext } from 'quickjs-emscripten';

type TestEntry = { name: string; passed: boolean; error?: string };
type Log = (type: 'info' | 'error', message: string) => void;

/**
 * `pm.test` outcomes in call order. A test is reserved before its callback
 * runs, so an async test that settles later keeps its place in the report;
 * a test still pending when the eval ends is failed, never reported as passed.
 */
export class PmTestRecorder {
  private readonly pending = new Set<number>();
  private readonly tests: () => TestEntry[];
  private readonly log: Log;

  constructor(tests: () => TestEntry[], log: Log) {
    this.tests = tests;
    this.log = log;
  }

  reset(): void {
    this.pending.clear();
  }

  reserve(name: string): number {
    const tests = this.tests();
    tests.push({ name, passed: false });
    const slot = tests.length - 1;
    this.pending.add(slot);
    return slot;
  }

  settle(slot: number, passed: boolean, error?: string): void {
    if (!this.pending.delete(slot)) return;
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

  /** Fail every test whose promise never settled (nothing left to resolve it). */
  failPending(message: string): void {
    for (const slot of [...this.pending]) this.settle(slot, false, message);
  }

  /** Expose reserve/settle to the sandbox for {@link installPmTest}. */
  bindNatives(vm: QuickJSContext): void {
    const reserveFn = vm.newFunction('reserveTest', (nameHandle) =>
      vm.newNumber(this.reserve(vm.getString(nameHandle)))
    );
    const settleFn = vm.newFunction('settleTest', (slotHandle, passedHandle, errorHandle) => {
      const error =
        errorHandle && vm.typeof(errorHandle) === 'string' ? vm.getString(errorHandle) : undefined;
      this.settle(vm.getNumber(slotHandle), vm.dump(passedHandle) === true, error);
    });
    vm.setProp(vm.global, '__pm_reserveTest', reserveFn);
    vm.setProp(vm.global, '__pm_settleTest', settleFn);
    reserveFn.dispose();
    settleFn.dispose();
  }
}

/**
 * Install `pm.test(name, fn)` (after `pm` is global): a thrown error or a
 * rejected returned promise fails the test; a returned promise is awaited
 * within the script's timeout.
 */
export function installPmTest(vm: QuickJSContext): void {
  const result = vm.evalCode(`(function () {
    var reserve = globalThis.__pm_reserveTest;
    var settle = globalThis.__pm_settleTest;
    delete globalThis.__pm_reserveTest;
    delete globalThis.__pm_settleTest;
    function message(e) {
      if (e && typeof e === 'object' && 'message' in e) return String(e.message);
      return String(e);
    }
    pm.test = function (name, fn) {
      var slot = reserve(String(name));
      var returned;
      try {
        returned = fn();
      } catch (e) {
        settle(slot, false, message(e));
        return;
      }
      if (returned && typeof returned.then === 'function') {
        returned.then(
          function () { settle(slot, true); },
          function (e) { settle(slot, false, message(e)); }
        );
      } else {
        settle(slot, true);
      }
    };
  })();`);
  if (result.error) result.error.dispose();
  else result.value.dispose();
}
