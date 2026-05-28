import { describe, it, expect, vi } from 'vitest';
import ScriptExecutor from '../scriptExecutor';
import type {
  PmCookieAdapter,
  PmCookieRecord,
  PmSendRequestInput,
  PmSubResponse,
} from '../scriptExecutor';

/**
 * Phase C integration — runner-aware APIs.
 *
 * Covers the four surfaces that bridge the QuickJS sandbox to the rest
 * of the app:
 *
 *   - `pm.sendRequest(input, callback)` — both callback + promise forms
 *     route through `host.sendRequest`. Asserts argument shape, response
 *     wrapping, error path.
 *   - `pm.cookies.{get,has,jar}` — backed by `host.cookies(currentUrl)`.
 *     The factory is rebound per-eval so the same `pm.cookies.get(name)`
 *     reads against the active request URL.
 *   - `pm.execution.setNextRequest / skipRequest` — Phase A already
 *     captured these; this suite verifies they survive a script that
 *     also fires sub-requests (i.e. the async pump doesn't drop the
 *     sentinel).
 *   - Host-bridge gating: `pm.sendRequest` is only bound when
 *     `host.sendRequest` is wired in — a script that calls it without
 *     a host gets a clean ReferenceError.
 */

function buildMockResponse(overrides: Partial<PmSubResponse> = {}): PmSubResponse {
  return {
    code: 200,
    status: 'OK',
    headers: { 'content-type': 'application/json' },
    body: '{"ok":true}',
    responseTime: 42,
    responseSize: 11,
    ...overrides,
  };
}

describe('pm.sendRequest — host bridge', () => {
  it('callback form: fires the host, response goes back via cb(null, res)', async () => {
    const seen: PmSendRequestInput[] = [];
    const host = {
      sendRequest: vi.fn(async (input: PmSendRequestInput) => {
        seen.push(input);
        return buildMockResponse({ code: 201 });
      }),
    };
    const ex = new ScriptExecutor({ host });
    const r = await ex.executeScript(
      `
      pm.sendRequest('https://api.example.com/v1/users', function (err, res) {
        pm.test('no err', function () { pm.expect(err).to.be.null; });
        pm.test('201', function () { pm.expect(res.code).to.equal(201); });
      });
    `,
      {}
    );
    expect(seen).toEqual([{ url: 'https://api.example.com/v1/users', method: 'GET' }]);
    expect(host.sendRequest).toHaveBeenCalledTimes(1);
    expect(r.tests?.every((t) => t.passed)).toBe(true);
  });

  it('object input form: passes method + headers + body through', async () => {
    const seen: PmSendRequestInput[] = [];
    const host = {
      sendRequest: vi.fn(async (input: PmSendRequestInput) => {
        seen.push(input);
        return buildMockResponse();
      }),
    };
    const ex = new ScriptExecutor({ host });
    await ex.executeScript(
      `
      pm.sendRequest({
        url: 'https://api/post',
        method: 'POST',
        header: { 'Content-Type': 'application/json' },
        body: '{"k":"v"}'
      }, function () {});
    `,
      {}
    );
    expect(seen[0]).toEqual({
      url: 'https://api/post',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"k":"v"}',
    });
  });

  it('promise form: await pm.sendRequest(url) resolves with the wrapped response', async () => {
    const host = {
      sendRequest: vi.fn(async () => buildMockResponse({ code: 200, body: '{"foo":1}' })),
    };
    const ex = new ScriptExecutor({ host });
    const r = await ex.executeScript(
      `
      (async function () {
        var res = await pm.sendRequest('https://api/users');
        pm.test('200', function () { pm.expect(res.code).to.equal(200); });
        pm.test('body', function () { pm.expect(res.body).to.equal('{"foo":1}'); });
      })();
    `,
      {}
    );
    expect(r.tests?.every((t) => t.passed)).toBe(true);
  });

  it('error path: host rejection surfaces to the callback first arg', async () => {
    const host = {
      sendRequest: vi.fn(async () => {
        throw new Error('SSRF: blocked metadata host');
      }),
    };
    const ex = new ScriptExecutor({ host });
    const r = await ex.executeScript(
      `
      pm.sendRequest('http://169.254.169.254/latest/meta-data/', function (err, res) {
        pm.test('error fired', function () { pm.expect(err).to.not.be.null; });
        pm.test('message', function () { pm.expect(err.message).to.match(/SSRF/); });
        pm.test('no response', function () { pm.expect(res).to.be.null; });
      });
    `,
      {}
    );
    expect(r.tests?.every((t) => t.passed)).toBe(true);
  });

  it('no host bound: pm.sendRequest is undefined (ReferenceError on call)', async () => {
    const ex = new ScriptExecutor({});
    const r = await ex.executeScript(
      `pm.test('absent', function () { pm.expect(pm.sendRequest).to.be.undefined; });`,
      {}
    );
    expect(r.tests?.every((t) => t.passed)).toBe(true);
  });
});

describe('pm.cookies — jar adapter', () => {
  function buildMockAdapter(seedRecords: PmCookieRecord[] = []): PmCookieAdapter {
    const store = [...seedRecords];
    return {
      forCurrentUrl: () => [...store],
      getForUrl: () => [...store],
      add: (_url, c) => {
        const i = store.findIndex((x) => x.name === c.name);
        if (i >= 0) store[i] = c;
        else store.push(c);
      },
      unset: (_url, name) => {
        const i = store.findIndex((x) => x.name === name);
        if (i >= 0) store.splice(i, 1);
      },
      clear: () => {
        store.length = 0;
      },
    };
  }

  it('pm.cookies.get / .has reflect the current-URL adapter', async () => {
    const adapter = buildMockAdapter([{ name: 'sid', value: 'abc' }]);
    const ex = new ScriptExecutor({ host: { cookies: () => adapter } });
    const r = await ex.executeScript(
      `
      pm.test('has', function () { pm.expect(pm.cookies.has('sid')).to.be.true; });
      pm.test('get', function () { pm.expect(pm.cookies.get('sid')).to.equal('abc'); });
      pm.test('missing', function () { pm.expect(pm.cookies.has('nope')).to.be.false; });
    `,
      { request: { url: 'https://api.example.com/v1', method: 'GET', headers: {} } }
    );
    expect(r.tests?.every((t) => t.passed)).toBe(true);
  });

  it('pm.cookies.jar().set / .get / .unset round-trips through the adapter', async () => {
    const calls: Array<{ op: string; args: unknown[] }> = [];
    const factory = () => ({
      forCurrentUrl: () => [],
      getForUrl: (url: string) => {
        calls.push({ op: 'getForUrl', args: [url] });
        return [{ name: 'x', value: '1' }];
      },
      add: (url: string, c: PmCookieRecord) => {
        calls.push({ op: 'add', args: [url, c.name, c.value] });
      },
      unset: (url: string, name: string) => {
        calls.push({ op: 'unset', args: [url, name] });
      },
      clear: (url: string) => {
        calls.push({ op: 'clear', args: [url] });
      },
    });
    const ex = new ScriptExecutor({ host: { cookies: factory } });
    await ex.executeScript(
      `
      var j = pm.cookies.jar();
      j.set('https://api/x', 'token', 'abc');
      var v = j.get('https://api/x', 'x');
      j.unset('https://api/x', 'token');
      j.clear('https://api/x');
    `,
      { request: { url: 'https://api/x', method: 'GET', headers: {} } }
    );
    expect(calls.find((c) => c.op === 'add')?.args).toEqual(['https://api/x', 'token', 'abc']);
    expect(calls.find((c) => c.op === 'getForUrl')?.args).toEqual(['https://api/x']);
    expect(calls.find((c) => c.op === 'unset')?.args).toEqual(['https://api/x', 'token']);
    expect(calls.find((c) => c.op === 'clear')?.args).toEqual(['https://api/x']);
  });

  it('no host.cookies bound: pm.cookies.get returns undefined / has returns false', async () => {
    const ex = new ScriptExecutor({});
    const r = await ex.executeScript(
      `
      pm.test('get undef', function () { pm.expect(pm.cookies.get('x')).to.be.undefined; });
      pm.test('has false', function () { pm.expect(pm.cookies.has('x')).to.be.false; });
    `,
      { request: { url: 'https://api/x', method: 'GET', headers: {} } }
    );
    expect(r.tests?.every((t) => t.passed)).toBe(true);
  });
});

describe('pm.sendRequest — wall-clock guard', () => {
  it('a hung host promise is killed by the async deadline', async () => {
    // Host promise that never settles. Without the wall-clock guard the
    // executor would pin on this forever — QuickJS's interrupt handler
    // can't fire because no JS bytecode is running while the user
    // script awaits, so `evalInterrupted` would never flip without our
    // setTimeout-pump checking Date.now() against the deadline.
    const host = {
      sendRequest: vi.fn(() => new Promise<never>(() => undefined)),
    };
    const ex = new ScriptExecutor({ host });
    await ex.initialize();
    // Shorten the async ceiling so the deadline trips in ~50ms instead
    // of the production 30s. Production code never calls this; it's
    // declared on the class specifically for this kind of timing test.
    ex.__setCeilingsForTest(undefined, 50);
    const r = await ex.eval(
      `pm.sendRequest('https://hang.example/never-returns', function () {});`,
      {}
    );
    expect(r.errors.some((e) => /timed out/.test(e))).toBe(true);
    ex.dispose();
  }, 10_000);
});

describe('pm.execution survives async pm.sendRequest', () => {
  it('setNextRequest still surfaces when called before/after a sub-request', async () => {
    const host = { sendRequest: async () => buildMockResponse() };
    const ex = new ScriptExecutor({ host });
    const r = await ex.executeScript(
      `
      pm.execution.setNextRequest('Login');
      pm.sendRequest('https://api/health', function () {});
    `,
      {}
    );
    expect(r.execution).toEqual({ nextRequest: 'Login' });
  });
});
