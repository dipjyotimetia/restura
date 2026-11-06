/**
 * Unhandled promise rejections in a script, tracked inside the QuickJS
 * sandbox. quickjs-emscripten exposes no host rejection tracker
 * (`JS_SetHostPromiseRejectionTracker`), so the bootstrap below replaces the
 * global `Promise` with a constructor that shares the native prototype and
 * wraps `Promise.prototype.then`:
 *
 * - Every promise built through the constructor is registered: `new Promise`,
 *   the statics (`resolve`, `reject`, `all`, ...) and every promise `then` /
 *   `catch` / `finally` derive (species construction reads
 *   `promise.constructor`, which is now the wrapper). Host-bridge promises
 *   (`vm.newPromise`) are registered by the host through {@link RejectionTracker.track}.
 * - A registered promise gets an internal observer reaction (excluded from
 *   the handled bookkeeping); when it rejects with no handler attached yet, it
 *   is recorded as unhandled.
 * - Calling `then` (which `catch` / `finally` / `Promise.all` & co. go
 *   through) on a promise marks it handled and drops any record. Because the
 *   prototype's `constructor` is no longer the intrinsic `%Promise%`, an
 *   `await` on a native promise also goes through `then`, so awaiting a
 *   rejection in a `try` handles it.
 *
 * Remaining limitation: the promise a native async function returns is made
 * inside the engine, not through the constructor, so one that is dropped
 * without ever being awaited or `then`-ed (a mid-script async IIFE that
 * throws) cannot be observed. The executor still reports it when it is the
 * script's last expression.
 *
 * The tracker's state lives in the bootstrap's closure; the API object it
 * returns is held only by the host. The primitives it relies on are captured
 * up front, and `then` / `constructor` are non-writable and non-configurable,
 * so a script cannot hide a rejection by reassigning them (it can always
 * silence its own reporting some other way, which only affects itself).
 */
import type { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten';

export const REJECTION_TRACKER_SOURCE = `(function () {
  'use strict';
  var NativePromise = globalThis.Promise; // not Promise: the declaration below is hoisted
  var proto = NativePromise.prototype;
  var call = Function.prototype.call;
  var nativeThen = call.bind(proto.then);
  var construct = Reflect.construct;
  var defineProperty = Object.defineProperty;
  var getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  var ownKeys = Reflect.ownKeys;
  var mapSet = call.bind(Map.prototype.set);
  var mapDelete = call.bind(Map.prototype.delete);
  var mapForEach = call.bind(Map.prototype.forEach);
  var weakAdd = call.bind(WeakSet.prototype.add);
  var weakHas = call.bind(WeakSet.prototype.has);
  var MapCtor = Map;
  var WeakSetCtor = WeakSet;

  var epoch = 0;
  var internal = false;
  var handled = new WeakSetCtor();
  var unhandled = new MapCtor();

  function observe(promise) {
    var at = epoch;
    internal = true;
    try {
      nativeThen(promise, undefined, function (reason) {
        if (at === epoch && !weakHas(handled, promise)) mapSet(unhandled, promise, reason);
      });
    } finally {
      internal = false;
    }
  }

  function markHandled(promise) {
    weakAdd(handled, promise);
    mapDelete(unhandled, promise);
  }

  function Promise(executor) {
    if (new.target === undefined) {
      throw new TypeError("Promise constructor cannot be invoked without 'new'");
    }
    var promise = construct(NativePromise, [executor], new.target);
    if (!internal) observe(promise);
    return promise;
  }
  var keys = ownKeys(NativePromise);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (key === 'prototype' || key === 'length' || key === 'name') continue;
    defineProperty(Promise, key, getOwnPropertyDescriptor(NativePromise, key));
  }
  defineProperty(Promise, 'prototype', { value: proto, writable: false });

  function then(onFulfilled, onRejected) {
    var derived = nativeThen(this, onFulfilled, onRejected);
    if (!internal) markHandled(this);
    return derived;
  }
  defineProperty(then, 'name', { value: 'then' });
  defineProperty(proto, 'then', { value: then, writable: false, enumerable: false, configurable: false });
  defineProperty(proto, 'constructor', { value: Promise, writable: false, enumerable: false, configurable: false });
  defineProperty(globalThis, 'Promise', { value: Promise, writable: true, enumerable: false, configurable: true });

  return Object.freeze({
    track: function (promise) { observe(promise); },
    handled: function (promise) { markHandled(promise); },
    reset: function () { epoch++; unhandled = new MapCtor(); },
    collect: function () {
      var out = [];
      var n = 0;
      mapForEach(unhandled, function (reason) {
        defineProperty(out, n++, { value: reason, writable: true, enumerable: true, configurable: true });
      });
      unhandled = new MapCtor();
      return out;
    },
  });
})()`;

type TrackerFn = 'track' | 'handled' | 'reset' | 'collect';

/** Host half of the in-sandbox tracker: one per QuickJS context. */
export class RejectionTracker {
  private api: QuickJSHandle | null = null;

  /** Evaluate the bootstrap. Returns an error message when it fails. */
  install(vm: QuickJSContext): string | undefined {
    const r = vm.evalCode(REJECTION_TRACKER_SOURCE, 'rejection-tracker.js');
    if (r.error) {
      const dump = vm.dump(r.error);
      r.error.dispose();
      return typeof dump === 'string' ? dump : JSON.stringify(dump);
    }
    this.api = r.value;
    return undefined;
  }

  private invoke(vm: QuickJSContext, name: TrackerFn, arg?: QuickJSHandle): QuickJSHandle | null {
    if (!this.api?.alive) return null;
    const fn = vm.getProp(this.api, name);
    const r = arg ? vm.callFunction(fn, vm.undefined, arg) : vm.callFunction(fn, vm.undefined);
    fn.dispose();
    if (r.error) {
      r.error.dispose();
      return null;
    }
    return r.value;
  }

  private run(vm: QuickJSContext, name: TrackerFn, arg?: QuickJSHandle): void {
    this.invoke(vm, name, arg)?.dispose();
  }

  /** Forget everything recorded so far (start of an eval). */
  reset(vm: QuickJSContext): void {
    this.run(vm, 'reset');
  }

  /** Register a promise created outside the constructor (a host bridge's `vm.newPromise`). */
  track(vm: QuickJSContext, promise: QuickJSHandle): void {
    this.run(vm, 'track', promise);
  }

  /** Mark a promise the host already reported (the script's completion value) as handled. */
  markHandled(vm: QuickJSContext, promise: QuickJSHandle): void {
    this.run(vm, 'handled', promise);
  }

  /** The reasons of every rejection still unhandled, then clear them. */
  collect(vm: QuickJSContext, describe: (h: QuickJSHandle) => string): string[] {
    const list = this.invoke(vm, 'collect');
    if (!list) return [];
    const messages: string[] = [];
    try {
      const lengthHandle = vm.getProp(list, 'length');
      const length = vm.getNumber(lengthHandle);
      lengthHandle.dispose();
      for (let i = 0; i < length; i++) {
        const reason = vm.getProp(list, i);
        messages.push(`Unhandled promise rejection: ${describe(reason)}`);
        reason.dispose();
      }
    } finally {
      list.dispose();
    }
    return messages;
  }

  dispose(): void {
    if (this.api?.alive) this.api.dispose();
    this.api = null;
  }
}
