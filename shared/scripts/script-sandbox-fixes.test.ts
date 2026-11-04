import { describe, expect, it, vi } from 'vitest';
import ScriptExecutor from './script-executor';
import type { PmSubResponse, ScriptHostBridges } from './script-executor-types';
import { NO_SCRIPT_HOST, runScriptPhase } from './script-phase';

const run = (script: string, options: ConstructorParameters<typeof ScriptExecutor>[0] = {}) =>
  new ScriptExecutor(options).executeScript(script, {});

const subResponse = (overrides: Partial<PmSubResponse> = {}): PmSubResponse => ({
  code: 200,
  status: 'OK',
  headers: { 'Content-Type': 'application/json' },
  body: '{"token":"t1"}',
  responseTime: 3,
  responseSize: 14,
  ...overrides,
});

describe('top-level await', () => {
  it('runs a script that awaits at the top level', async () => {
    const host: ScriptHostBridges = { sendRequest: vi.fn(async () => subResponse()) };
    const r = await run(
      `const res = await pm.sendRequest('https://api.test/login');
       pm.variables.set('token', res.json().token);
       pm.test('after await', function () { pm.expect(res.code).to.equal(200); });`,
      { host }
    );
    expect(r.errors).toEqual([]);
    expect(r.variables?.token).toBe('t1');
    expect(r.tests).toEqual([{ name: 'after await', passed: true }]);
  });

  it('awaits a plain promise without a host', async () => {
    const r = await run(
      "const v = await Promise.resolve(41); pm.variables.set('v', String(v + 1));"
    );
    expect(r.success).toBe(true);
    expect(r.variables?.v).toBe('42');
  });

  it('a rejection at the top level is a script error', async () => {
    const r = await run("await Promise.resolve(); throw new Error('late boom');");
    expect(r.success).toBe(false);
    expect(r.errors.join('\n')).toMatch(/late boom/);
  });

  it('keeps the line number of an error after an await', async () => {
    const r = await run('await 1;\nnull.x;');
    expect(r.errors.join('\n')).toMatch(/user-script\.js:2/);
  });

  it('leaves scripts without await unchanged (var stays global, last value ignored)', async () => {
    const r = await run(
      "var g = 1; function f() { return g + 1; } pm.variables.set('f', String(globalThis.f && f()));"
    );
    expect(r.variables?.f).toBe('2');
  });
});

describe('pm.sendRequest response and callback', () => {
  it('the sub-response has Postman json(), text(), code, status and headers.get()', async () => {
    const host: ScriptHostBridges = { sendRequest: vi.fn(async () => subResponse()) };
    const r = await run(
      `pm.sendRequest('https://api.test/x', function (err, res) {
        pm.test('shape', function () {
          pm.expect(err).to.equal(null);
          pm.expect(res.json().token).to.equal('t1');
          pm.expect(res.text()).to.equal('{"token":"t1"}');
          pm.expect(res.code).to.equal(200);
          pm.expect(res.status).to.equal('OK');
          pm.expect(res.headers.get('content-type')).to.equal('application/json');
          pm.expect(res.headers.has('Content-Type')).to.equal(true);
        });
      });`,
      { host }
    );
    expect(r.tests).toEqual([{ name: 'shape', passed: true }]);
    expect(r.errors).toEqual([]);
  });

  it('an error thrown inside the callback is a script error', async () => {
    const host: ScriptHostBridges = { sendRequest: vi.fn(async () => subResponse()) };
    const r = await run(
      "pm.sendRequest('https://api.test/x', function (err, res) { throw new Error('cb boom'); });",
      { host }
    );
    expect(r.success).toBe(false);
    expect(r.errors.join('\n')).toMatch(/cb boom/);
  });

  it('a callback that receives the host error does not also fail the script', async () => {
    const host: ScriptHostBridges = {
      sendRequest: vi.fn(async () => {
        throw new Error('refused');
      }),
    };
    const r = await run(
      "pm.sendRequest('https://api.test/x', function (err) { pm.variables.set('e', err.message); });",
      { host }
    );
    expect(r.errors).toEqual([]);
    expect(r.variables?.e).toBe('refused');
  });

  it('without a host, pm.sendRequest is defined and rejects with a clear error', async () => {
    const r = await run(
      `pm.variables.set('type', typeof pm.sendRequest);
       pm.sendRequest('https://api.test/x', function (err) { pm.variables.set('e', err.message); });`
    );
    expect(r.variables?.type).toBe('function');
    expect(r.variables?.e).toMatch(/pm\.sendRequest.*not available/);
  });
});

describe('pm.test with a done callback', () => {
  it('fails when done is called with an error', async () => {
    const r = await run(
      "pm.test('d', function (done) { Promise.resolve().then(function () { done(new Error('nope')); }); });"
    );
    expect(r.tests).toEqual([{ name: 'd', passed: false, error: 'nope' }]);
  });

  it('passes when done is called after async work', async () => {
    const r = await run(
      "pm.test('d', function (done) { Promise.resolve().then(function () { pm.expect(1).to.eql(1); done(); }); });"
    );
    expect(r.tests).toEqual([{ name: 'd', passed: true }]);
  });

  it('fails when an assertion throws in the async continuation before done', async () => {
    const r = await run(
      "pm.test('d', function (done) { Promise.resolve().then(function () { pm.expect(1).to.eql(2); done(); }); });"
    );
    expect(r.tests?.[0]?.passed).toBe(false);
    expect(r.tests?.[0]?.error).toMatch(/expected 1 to deeply equal 2/);
  });

  it('waits for done called from a sub-request callback', async () => {
    const host: ScriptHostBridges = { sendRequest: vi.fn(async () => subResponse()) };
    const r = await run(
      `pm.test('d', function (done) {
        pm.sendRequest('https://api.test/x', function (err, res) {
          pm.expect(res.code).to.equal(201);
          done();
        });
      });`,
      { host }
    );
    expect(r.tests?.[0]?.passed).toBe(false);
  });
});

describe('unhandled promise rejections', () => {
  it('reports a rejected async IIFE as a script error', async () => {
    const r = await run("(async function () { throw new Error('boom'); })();");
    expect(r.success).toBe(false);
    expect(r.errors.join('\n')).toMatch(/boom/);
  });

  it('does not report a rejection the script handled', async () => {
    const r = await run(
      "(async function () { throw new Error('boom'); })().catch(function () { pm.variables.set('c', '1'); });"
    );
    expect(r.errors).toEqual([]);
    expect(r.variables?.c).toBe('1');
  });
});

describe('pm.variables precedence', () => {
  it('sees collectionVariables.set and globals.set from the same script', async () => {
    const r = await run(
      `pm.collectionVariables.set('cv', 'X');
       pm.globals.set('g', 'G');
       pm.variables.set('out', pm.variables.get('cv') + '|' + pm.variables.get('g'));`
    );
    expect(r.variables?.out).toBe('X|G');
  });

  it('local beats environment beats collection beats globals', async () => {
    const r = await run(
      `pm.globals.set('k', 'global');
       pm.collectionVariables.set('k', 'collection');
       var a = pm.variables.get('k');
       pm.environment.set('k', 'env');
       var b = pm.variables.get('k');
       pm.variables.set('k', 'local');
       pm.variables.set('out', [a, b, pm.variables.get('k')].join('|'));`
    );
    expect(r.variables?.out).toBe('collection|env|local');
  });

  it('a collection write overrides the stale merged value that came from the collection', async () => {
    const r = await run(
      "pm.collectionVariables.set('cv', 'new'); pm.variables.set('out', pm.variables.get('cv'));",
      { envVars: { cv: 'old' }, collectionVars: { cv: 'old' } }
    );
    expect(r.variables?.out).toBe('new');
  });
});

describe('variable namespaces', () => {
  it('does not read inherited object properties', async () => {
    const r = await run(
      `pm.variables.set('out', [
        typeof pm.environment.get('constructor'),
        pm.environment.has('toString'),
        typeof pm.globals.get('hasOwnProperty'),
        pm.collectionVariables.has('__proto__'),
      ].join('|'));`
    );
    expect(r.variables?.out).toBe('undefined|false|undefined|false');
  });

  it('stores objects as JSON, numbers as strings and undefined as empty', async () => {
    const r = await run(
      "pm.environment.set('obj', { a: 1 }); pm.environment.set('n', 5); pm.environment.set('u', undefined);"
    );
    expect(r.environmentMutations).toEqual({ obj: '{"a":1}', n: '5', u: '' });
  });
});

describe('pm.sendRequest input normalisation', () => {
  it('turns a Postman header list into a header map (disabled rows dropped)', async () => {
    const sendRequest = vi.fn(async () => subResponse());
    await run(
      `pm.sendRequest({ url: 'https://x', header: [
        { key: 'A', value: '1' }, { key: 'B', value: '2', disabled: true }, 'junk'
      ] }, function () {});`,
      { host: { sendRequest } }
    );
    expect(sendRequest).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://x', headers: { A: '1' } })
    );
  });
});

describe('failed assertions are not script errors', () => {
  it('a failed pm.test is reported on the test and as a console line, not in errors', async () => {
    const r = await run("pm.test('a', function () { pm.expect(1).to.equal(2); });");
    expect(r.tests?.[0]?.passed).toBe(false);
    expect(r.errors).toEqual([]);
    expect(r.logs.map((l) => [l.type, l.message])).toContainEqual([
      'error',
      '✗ a: expected 1 to equal 2',
    ]);
  });
});

describe('runScriptPhase absorb applies unsets', () => {
  it('pm.environment.unset and pm.variables.unset remove the key for this request', async () => {
    const into: Record<string, string> = { token: 'OLD', other: 'O', keep: 'K' };
    await runScriptPhase({
      phase: 'prerequest',
      script: "pm.environment.unset('token'); pm.variables.unset('other');",
      envVars: into,
      host: NO_SCRIPT_HOST,
      absorb: { into, variables: 'always' },
    });
    expect(into).toEqual({ keep: 'K' });
  });
});
