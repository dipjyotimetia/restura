import { describe, expect, it, vi } from 'vitest';
import ScriptExecutor from './script-executor';
import type { PmSubResponse, ScriptHostBridges } from './script-executor-types';

/**
 * A promise a script rejects and never handles is a script error, wherever the
 * script dropped it, not only as its last expression. QuickJS's host rejection
 * tracker is not exposed by quickjs-emscripten, so the sandbox tracks promises
 * itself (see rejection-tracker.ts) and these pin both directions: every
 * dropped rejection it can see is reported, and no handled one is.
 */

const run = (script: string, options: ConstructorParameters<typeof ScriptExecutor>[0] = {}) =>
  new ScriptExecutor(options).executeScript(script, {});

const subResponse = (): PmSubResponse => ({
  code: 200,
  status: 'OK',
  headers: {},
  body: '{}',
  responseTime: 1,
  responseSize: 2,
});

const unhandled = (errors: string[]) =>
  errors.filter((e) => e.startsWith('Unhandled promise rejection: '));

describe('dropped rejections are reported', () => {
  it('Promise.reject dropped mid-script', async () => {
    const r = await run("Promise.reject(new Error('dropped')); console.log('after'); 1");
    expect(r.success).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^Unhandled promise rejection: .*dropped/);
    expect(r.logs.some((l) => l.message === 'after')).toBe(true);
  });

  it('a throwing .then continuation that is dropped', async () => {
    const r = await run(
      "Promise.resolve(1).then(function () { throw new Error('in-then'); }); console.log('after');"
    );
    expect(r.success).toBe(false);
    expect(unhandled(r.errors)).toHaveLength(1);
    expect(r.errors[0]).toMatch(/in-then/);
  });

  it('a then() chained on an async function and dropped', async () => {
    const r = await run(
      "async function fetchSomething() { return 1; }\nfetchSomething().then(function () { throw new Error('chained'); });\nvar x = 2;"
    );
    expect(r.success).toBe(false);
    expect(r.errors.join('\n')).toMatch(/Unhandled promise rejection: .*chained/);
  });

  it('a new Promise rejected by its executor and dropped', async () => {
    const r = await run(
      "new Promise(function (_res, rej) { rej(new Error('ctor')); }); console.log('x');"
    );
    expect(r.success).toBe(false);
    expect(r.errors.join('\n')).toMatch(/ctor/);
  });

  it('a string reason', async () => {
    const r = await run("Promise.reject('plain'); 1");
    expect(r.errors).toEqual(['Unhandled promise rejection: plain']);
  });

  it('each distinct dropped rejection once', async () => {
    const r = await run("Promise.reject('a'); Promise.reject('b'); 1");
    expect(r.errors).toEqual(['Unhandled promise rejection: a', 'Unhandled promise rejection: b']);
  });

  it('a then() without a rejection handler forwards the rejection, reported once', async () => {
    const r = await run("Promise.reject('fwd').then(function () {}); 1");
    expect(r.errors).toEqual(['Unhandled promise rejection: fwd']);
  });

  it('a dropped rejection inside a top-level-await script', async () => {
    const r = await run("await Promise.resolve(); Promise.reject('tla-drop'); var y = 1;");
    expect(r.errors).toEqual(['Unhandled promise rejection: tla-drop']);
  });

  it('a dropped rejection inside an async pm.test body', async () => {
    const r = await run("pm.test('t', async function () { Promise.reject('in-test'); });");
    expect(r.tests).toEqual([{ name: 't', passed: true }]);
    expect(r.errors).toEqual(['Unhandled promise rejection: in-test']);
  });

  it('a dropped pm.sendRequest whose .then throws', async () => {
    const host: ScriptHostBridges = { sendRequest: vi.fn(async () => subResponse()) };
    const r = await run(
      "pm.sendRequest('https://api.test/x').then(function () { throw new Error('after-send'); }); console.log('after');",
      { host }
    );
    expect(r.success).toBe(false);
    expect(r.errors.join('\n')).toMatch(/Unhandled promise rejection: .*after-send/);
  });

  it('a dropped pm.sendRequest that rejects (no callback)', async () => {
    const host: ScriptHostBridges = {
      sendRequest: vi.fn(async () => {
        throw new Error('net down');
      }),
    };
    const r = await run("pm.sendRequest('https://api.test/x'); 1", { host });
    expect(r.success).toBe(false);
    expect(r.errors.join('\n')).toMatch(/Unhandled promise rejection: .*net down/);
  });

  it('a dropped host-bridge promise (pm.vault with no adapter)', async () => {
    const r = await run("pm.vault.get('k'); 1");
    expect(r.success).toBe(false);
    expect(r.errors.join('\n')).toMatch(/Unhandled promise rejection: .*no host adapter/);
  });

  it('a resolve() that adopts a rejected promise', async () => {
    const r = await run("new Promise(function (res) { res(Promise.reject('adopted')); }); 1");
    expect(r.errors).toEqual(['Unhandled promise rejection: adopted']);
  });
});

describe('handled rejections are not reported', () => {
  const clean = async (script: string, options = {}) => {
    const r = await run(script, options);
    expect(r.errors).toEqual([]);
    expect(r.success).toBe(true);
    return r;
  };

  it('.catch(() => {})', async () => {
    await clean("Promise.reject(new Error('x')).catch(function () {}); 1");
  });

  it('then(onFulfilled, onRejected)', async () => {
    await clean("Promise.reject('x').then(function () {}, function () {}); 1");
  });

  it('.finally(...).catch(...)', async () => {
    await clean("Promise.reject('x').finally(function () {}).catch(function () {}); 1");
  });

  it('a handler attached later in the same turn', async () => {
    await clean("var p = Promise.reject('x'); var q = 1 + 1; p.catch(function () {}); q");
  });

  it('a handler attached after an await', async () => {
    await clean(
      "const p = Promise.reject('x'); await Promise.resolve(); await null; p.catch(function () {});"
    );
  });

  it('a handler attached in a later .then continuation', async () => {
    await clean(
      "var p = Promise.reject('x'); Promise.resolve().then(function () { return null; }).then(function () { p.catch(function () {}); }); 1"
    );
  });

  it('Promise.allSettled', async () => {
    const r = await clean(
      "Promise.allSettled([Promise.reject('x'), Promise.resolve(1)]).then(function (s) { pm.variables.set('s', s.map(function (e) { return e.status; }).join(',')); }); 1"
    );
    expect(r.variables?.s).toBe('rejected,fulfilled');
  });

  it('Promise.all / race / any with a catch', async () => {
    await clean(
      `Promise.all([Promise.reject('a')]).catch(function () {});
       Promise.race([Promise.reject('b')]).catch(function () {});
       Promise.any([Promise.reject('c')]).catch(function () {});
       1`
    );
  });

  it('try { await p } catch {} inside an async function', async () => {
    const r = await clean(
      "(async function () { try { await Promise.reject(new Error('x')); } catch (e) { pm.variables.set('c', '1'); } })(); 1"
    );
    expect(r.variables?.c).toBe('1');
  });

  it('try { await p } catch {} at the top level', async () => {
    await clean("try { await Promise.reject(new Error('x')); } catch (e) {}");
  });

  it('a later await on a stored rejected promise', async () => {
    await clean("const p = Promise.reject('x'); await null; try { await p; } catch (e) {}");
  });

  it('an async pm.test that awaits a rejection fails the test, not the script', async () => {
    const r = await run(
      "pm.test('t', async function () { await Promise.reject(new Error('nope')); });"
    );
    expect(r.errors).toEqual([]);
    expect(r.tests?.[0]?.passed).toBe(false);
    expect(r.tests?.[0]?.error).toMatch(/nope/);
  });

  it('a pm.test returning a rejected promise fails the test, not the script', async () => {
    const r = await run("pm.test('t', function () { return Promise.reject(new Error('n')); });");
    expect(r.errors).toEqual([]);
    expect(r.tests?.[0]?.passed).toBe(false);
  });

  it('a rejected pm.sendRequest with a callback goes to the callback', async () => {
    const host: ScriptHostBridges = {
      sendRequest: vi.fn(async () => {
        throw new Error('net down');
      }),
    };
    const r = await clean(
      "pm.sendRequest('https://api.test/x', function (err) { pm.variables.set('e', err ? '1' : '0'); }); 1",
      { host }
    );
    expect(r.variables?.e).toBe('1');
  });

  it('an awaited pm.sendRequest rejection caught by try/catch', async () => {
    const host: ScriptHostBridges = {
      sendRequest: vi.fn(async () => {
        throw new Error('net down');
      }),
    };
    await clean("try { await pm.sendRequest('https://api.test/x'); } catch (e) {}", { host });
  });

  it('an awaited pm.vault rejection caught by try/catch', async () => {
    await clean("try { await pm.vault.get('k'); } catch (e) {}");
  });

  it('a thenable resolution that is later handled', async () => {
    await clean(
      "new Promise(function (res) { res(Promise.reject('x')); }).catch(function () {}); 1"
    );
  });
});

describe('existing completion reporting is unchanged and not duplicated', () => {
  it('a rejected promise as the last expression is reported once', async () => {
    const r = await run("Promise.reject(new Error('last'))");
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^Unhandled promise rejection: .*last/);
  });

  it('a rejected .then chain as the last expression is reported once', async () => {
    const r = await run("Promise.resolve().then(function () { throw new Error('last-then'); })");
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/last-then/);
  });

  it('a rejected async IIFE as the last expression is reported once', async () => {
    const r = await run("(async function () { await null; throw new Error('iife'); })()");
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^Unhandled promise rejection: .*iife/);
  });

  it('a rejected top-level await is a script error, reported once', async () => {
    const r = await run("await Promise.reject(new Error('tla'));");
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^Script execution error: .*tla/);
  });

  it('a top-level await of a dropped .then rejection is reported once', async () => {
    const r = await run("await Promise.resolve().then(function () { throw new Error('t2'); });");
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^Script execution error: .*t2/);
  });
});

describe('scripts that do not reject behave as before', () => {
  it('promise identity and subclassing', async () => {
    const r = await run(`
      var a = (async function () { return 1; })();
      var b = Promise.resolve(2);
      class MyP extends Promise {}
      var c = new MyP(function (res) { res(3); });
      var out = [
        a instanceof Promise, b instanceof Promise, a.constructor === Promise,
        c instanceof MyP, c instanceof Promise, c.then(function () {}) instanceof MyP,
        Promise.resolve(b) === b, typeof Promise.withResolvers, Promise.name, Promise.length,
      ].join(',');
      var threw = false;
      try { Promise(function () {}); } catch (e) { threw = e instanceof TypeError; }
      pm.variables.set('out', out + ',' + threw);
      Promise.all([a, b, c]).then(function (v) { pm.variables.set('sum', String(v[0] + v[1] + v[2])); });
    `);
    expect(r.errors).toEqual([]);
    expect(r.variables?.out).toBe('true,true,true,true,true,true,true,function,Promise,1,true');
    expect(r.variables?.sum).toBe('6');
  });

  it('microtask order of plain then chains is preserved', async () => {
    const r = await run(`
      var order = [];
      Promise.resolve().then(function () { order.push('a1'); }).then(function () { order.push('a2'); });
      Promise.resolve().then(function () { order.push('b1'); }).then(function () { order.push('b2'); });
      Promise.resolve().then(function () { return null; }).then(function () { return null; }).then(function () {
        pm.variables.set('order', order.join(','));
      });
      1`);
    expect(r.variables?.order).toBe('a1,b1,a2,b2');
  });
});

describe('the tracker cannot be reached or bypassed from the script', () => {
  it('adds no globals', async () => {
    const r = await run(
      "pm.variables.set('k', Object.getOwnPropertyNames(globalThis).filter(function (k) { return /reject|track/i.test(k); }).join(','));"
    );
    expect(r.variables?.k).toBe('');
  });

  it('overwriting Promise.prototype.then / constructor does not hide a later rejection', async () => {
    const r = await run(`
      try { Promise.prototype.then = function () { return this; }; } catch (e) {}
      try { Object.defineProperty(Promise.prototype, 'then', { value: function () {} }); } catch (e) {}
      try { Promise.prototype.constructor = Object; } catch (e) {}
      Promise.reject('still-seen'); 1`);
    expect(r.errors).toEqual(['Unhandled promise rejection: still-seen']);
  });

  it('a reused session does not carry a rejection into the next eval', async () => {
    const exec = new ScriptExecutor();
    await exec.initialize();
    try {
      const first = await exec.eval("Promise.reject('one'); 1");
      expect(first.errors).toEqual(['Unhandled promise rejection: one']);
      const second = await exec.eval('var z = 1;');
      expect(second.errors).toEqual([]);
      const third = await exec.eval("Promise.reject('three').catch(function () {}); 1");
      expect(third.errors).toEqual([]);
    } finally {
      exec.dispose();
    }
  });
});

describe('remaining limitation (QuickJS exposes no host rejection tracker)', () => {
  // A native async function's own promise is created inside the engine, not
  // through the Promise constructor, so one that is dropped without ever being
  // awaited or then()'d cannot be observed. Reported only as the last expression.
  it('an async IIFE dropped mid-script is not reported', async () => {
    const r = await run(
      "(async function () { throw new Error('invisible'); })(); console.log('after');"
    );
    expect(r.errors).toEqual([]);
  });
});
