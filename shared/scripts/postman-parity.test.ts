import { describe, expect, it } from 'vitest';
import ScriptExecutor from './script-executor';
import { applyScriptHeaderEdits } from './script-executor-request';
import type { ScriptContext } from './script-executor-types';

type Response = NonNullable<ScriptContext['response']>;

function response(overrides: Partial<Response> = {}): Response {
  return {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
    body: '{"id":"u1","nested":{"ok":true}}',
    time: 42,
    size: 10,
    ...overrides,
  };
}

async function run(script: string, context: Parameters<ScriptExecutor['executeScript']>[1] = {}) {
  return new ScriptExecutor({ envVars: {} }).executeScript(script, context);
}

function verdicts(result: Awaited<ReturnType<typeof run>>) {
  return Object.fromEntries((result.tests ?? []).map((t) => [t.name, t.passed]));
}

describe('pm.response assertions (Postman/chai property style)', () => {
  it('fails property-style `to.be.ok` / `to.be.success` on a 500', async () => {
    const result = await run(
      `pm.test('ok', function () { pm.response.to.be.ok; });
       pm.test('success', function () { pm.response.to.be.success; });
       pm.test('serverError', function () { pm.response.to.be.serverError; });`,
      { response: response({ status: 500, statusText: 'Internal Server Error' }) }
    );
    expect(verdicts(result)).toEqual({ ok: false, success: false, serverError: true });
  });

  it('still accepts the call form `to.be.ok()`', async () => {
    const result = await run(
      `pm.test('ok()', function () { pm.response.to.be.ok(); });
       pm.test('json()', function () { pm.response.to.be.json(); });`,
      { response: response() }
    );
    expect(verdicts(result)).toEqual({ 'ok()': true, 'json()': true });
  });

  it('treats a JSON string body (what the app sends) as JSON', async () => {
    const result = await run(
      `pm.test('be.json', function () { pm.response.to.be.json; });
       pm.test('jsonBody path', function () { pm.response.to.have.jsonBody('nested.ok', true); });
       pm.test('jsonBody exists', function () { pm.response.to.have.jsonBody('id'); });
       pm.test('jsonBody missing', function () { pm.response.to.have.jsonBody('nope'); });`,
      { response: response() }
    );
    expect(verdicts(result)).toEqual({
      'be.json': true,
      'jsonBody path': true,
      'jsonBody exists': true,
      'jsonBody missing': false,
    });
  });

  it('fails `to.be.json` for a non-JSON text body', async () => {
    const result = await run(`pm.test('json', function () { pm.response.to.be.json; });`, {
      response: response({ headers: { 'content-type': 'text/plain' }, body: 'hello' }),
    });
    expect(verdicts(result)).toEqual({ json: false });
  });

  it('negates with `to.not`', async () => {
    const result = await run(
      `pm.test('not ok on 404', function () { pm.response.to.not.be.ok; });
       pm.test('not status 200', function () { pm.response.to.not.have.status(200); });
       pm.test('not header', function () { pm.response.to.not.have.header('x-missing'); });
       pm.test('not status 404 fails', function () { pm.response.to.not.have.status(404); });`,
      { response: response({ status: 404, statusText: 'Not Found' }) }
    );
    expect(verdicts(result)).toEqual({
      'not ok on 404': true,
      'not status 200': true,
      'not header': true,
      'not status 404 fails': false,
    });
  });

  it('matches `to.have.status` by reason phrase and `to.have.body` by text', async () => {
    const result = await run(
      `pm.test('status text', function () { pm.response.to.have.status('OK'); });
       pm.test('body text', function () { pm.response.to.have.body('{"id":"u1","nested":{"ok":true}}'); });
       pm.test('body object', function () { pm.response.to.have.body({ id: 'u1', nested: { ok: true } }); });`,
      { response: response() }
    );
    expect(verdicts(result)).toEqual({
      'status text': true,
      'body text': true,
      'body object': true,
    });
  });

  it('exposes code (number), status (text) and responseTime (number)', async () => {
    const result = await run(
      `pm.test('code', function () { pm.expect(pm.response.code).to.equal(200); });
       pm.test('status', function () { pm.expect(pm.response.status).to.equal('OK'); });
       pm.test('responseTime', function () { pm.expect(pm.response.responseTime).to.be.a('number').and.below(1000); });`,
      { response: response() }
    );
    expect(verdicts(result)).toEqual({ code: true, status: true, responseTime: true });
  });
});

describe('async pm.test', () => {
  it('fails a test whose returned promise rejects', async () => {
    const result = await run(
      `pm.test('async rejects', async function () {
         await Promise.resolve();
         pm.expect(1).to.equal(2);
       });
       pm.test('async passes', async function () {
         await Promise.resolve();
         pm.expect(1).to.equal(1);
       });
       pm.test('sync passes', function () {});`
    );
    expect(result.tests?.map((t) => t.name)).toEqual([
      'async rejects',
      'async passes',
      'sync passes',
    ]);
    expect(verdicts(result)).toEqual({
      'async rejects': false,
      'async passes': true,
      'sync passes': true,
    });
    expect(result.tests?.[0]?.error).toMatch(/expected 1 to equal 2/);
  });

  it('fails a test whose promise never settles instead of passing it', async () => {
    const result = await run(
      `pm.test('hangs', function () { return new Promise(function () {}); });`
    );
    expect(verdicts(result)).toEqual({ hangs: false });
  });
});

describe('environment mutations', () => {
  it('reports pm.environment / environment / postman.* writes and unsets, not pm.variables', async () => {
    const result = await new ScriptExecutor({ envVars: { gone: 'x', keep: 'y' } }).executeScript(
      `pm.environment.set('token', 'abc');
       environment.set('other', '1');
       postman.setEnvironmentVariable('legacy', 'L');
       pm.environment.unset('gone');
       pm.variables.set('local', 'only-this-request');`,
      {}
    );
    expect(result.environmentMutations).toEqual({
      token: 'abc',
      other: '1',
      legacy: 'L',
      gone: null,
    });
    expect(result.variables.local).toBe('only-this-request');
  });

  it('keeps writes made before a later statement throws', async () => {
    const result = await new ScriptExecutor({ envVars: {} }).executeScript(
      `pm.environment.set('before', '1'); throw new Error('boom');`,
      {}
    );
    expect(result.success).toBe(false);
    expect(result.variables.before).toBe('1');
    expect(result.environmentMutations).toEqual({ before: '1' });
  });
});

describe('pm.request.headers mutation', () => {
  const request = {
    url: 'https://api.example.com',
    method: 'GET',
    headers: { Accept: 'application/json', 'X-Old': 'gone' },
  };

  it('supports add / upsert / remove / get / has / toObject and reports the final headers', async () => {
    const result = await run(
      `pm.variables.set('kept', 'yes');
       pm.request.headers.add({ key: 'X-Trace', value: 't1' });
       pm.request.headers.upsert({ key: 'accept', value: 'text/plain' });
       pm.request.headers.remove('x-old');
       pm.test('get', function () { pm.expect(pm.request.headers.get('x-trace')).to.equal('t1'); });
       pm.test('has', function () { pm.expect(pm.request.headers.has('Accept')).to.equal(true); });
       pm.test('toObject', function () {
         pm.expect(pm.request.headers.toObject()).to.eql({ Accept: 'text/plain', 'X-Trace': 't1' });
       });`,
      { request }
    );
    expect(result.errors).toEqual([]);
    expect(verdicts(result)).toEqual({ get: true, has: true, toObject: true });
    expect(result.requestHeaders).toEqual({ Accept: 'text/plain', 'X-Trace': 't1' });
    expect(result.variables.kept).toBe('yes');
  });

  it('reports no header edits when the script leaves headers alone', async () => {
    const result = await run(`pm.request.headers.get('Accept');`, { request });
    expect(result.requestHeaders).toBeUndefined();
  });

  it('folds header edits back onto key/value rows', () => {
    const rows = [
      { id: '1', key: 'Accept', value: '{{accept}}', enabled: true },
      { id: '2', key: 'X-Old', value: 'v', enabled: true },
      { id: '3', key: 'X-Off', value: 'v', enabled: false },
      { id: '4', key: 'Keep', value: '{{tpl}}', enabled: true },
    ];
    const next = applyScriptHeaderEdits(
      rows,
      { Accept: 'a', 'X-Old': 'v', Keep: 'resolved' },
      { Accept: 'text/plain', Keep: 'resolved', 'X-New': 'n' },
      () => 'new-id'
    );
    expect(next).toEqual([
      { id: '1', key: 'Accept', value: 'text/plain', enabled: true },
      { id: '2', key: 'X-Old', value: 'v', enabled: false },
      { id: '3', key: 'X-Off', value: 'v', enabled: false },
      { id: '4', key: 'Keep', value: '{{tpl}}', enabled: true },
      { id: 'new-id', key: 'X-New', value: 'n', enabled: true },
    ]);
  });
});
