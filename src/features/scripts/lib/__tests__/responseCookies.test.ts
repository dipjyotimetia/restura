import { describe, expect, it } from 'vitest';
import ScriptExecutor from '../scriptExecutor';

// #855: scripts must see every Set-Cookie, and `headers['set-cookie']` must be
// the same string on every harness (web got last-cookie-only, desktop/CLI got
// a comma-joined list).

const COOKIES = [
  'session=abc; Path=/; HttpOnly',
  'csrf=xyz; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Secure',
  'pref=dark',
];
const JOINED = COOKIES.join(', ');

function responseWith(headers: Record<string, string>, setCookies?: string[]) {
  return {
    status: 200,
    statusText: 'OK',
    headers,
    ...(setCookies ? { setCookies } : {}),
    body: '',
    time: 1,
    size: 0,
  };
}

const ASSERTIONS = `
  pm.test('flat header is the joined list', function () {
    pm.expect(response.headers['set-cookie']).to.equal(${JSON.stringify(JOINED)});
    pm.expect(pm.response.headers.get('Set-Cookie')).to.equal(${JSON.stringify(JOINED)});
  });
  pm.test('every cookie is listed', function () {
    pm.expect(response.setCookies).to.eql(${JSON.stringify(COOKIES)});
    var rows = pm.response.headers.all().filter(function (h) { return h.key.toLowerCase() === 'set-cookie'; });
    pm.expect(rows.map(function (h) { return h.value; })).to.eql(${JSON.stringify(COOKIES)});
    pm.expect(pm.response.headers.has('set-cookie', ${JSON.stringify(COOKIES[1])})).to.equal(true);
    pm.response.to.have.header('Set-Cookie', ${JSON.stringify(COOKIES[1])});
  });
  pm.test('pm.response.cookies parses each cookie', function () {
    pm.expect(pm.response.cookies.get('csrf')).to.equal('xyz');
    pm.expect(pm.response.cookies.has('pref')).to.equal(true);
    pm.expect(pm.response.cookies.has('missing')).to.equal(false);
    pm.expect(pm.response.cookies.get('missing')).to.equal(undefined);
    pm.expect(pm.response.cookies.toObject()).to.eql({ session: 'abc', csrf: 'xyz', pref: 'dark' });
    var all = pm.response.cookies.all();
    pm.expect(all.length).to.equal(3);
    pm.expect(all[0].httpOnly).to.equal(true);
    pm.expect(all[1].secure).to.equal(true);
    pm.expect(all[1].expires).to.equal('Wed, 21 Oct 2037 07:28:00 GMT');
    pm.expect(pm.response.cookies.toJSON()).to.eql(all);
  });
`;

async function run(response: ReturnType<typeof responseWith>) {
  const result = await new ScriptExecutor({}).executeScript(ASSERTIONS, { response });
  return result;
}

describe('test-script response cookies (#855)', () => {
  it('web/self-host shape: last cookie in the flat map + the authoritative list', async () => {
    const result = await run(responseWith({ 'set-cookie': 'pref=dark' }, COOKIES));
    expect(result.errors).toEqual([]);
    expect(result.tests?.map((t) => [t.name, t.passed, t.error])).toEqual([
      ['flat header is the joined list', true, undefined],
      ['every cookie is listed', true, undefined],
      ['pm.response.cookies parses each cookie', true, undefined],
    ]);
  });

  it('desktop/CLI shape: comma-joined flat map + the list', async () => {
    const result = await run(responseWith({ 'Set-Cookie': JOINED }, COOKIES));
    expect(result.tests?.every((t) => t.passed)).toBe(true);
  });

  it('legacy shape with no list: the folded header is split back into cookies', async () => {
    const result = await run(responseWith({ 'set-cookie': JOINED }));
    expect(result.tests?.every((t) => t.passed)).toBe(true);
  });

  it('responses without cookies expose empty, non-throwing accessors', async () => {
    const result = await new ScriptExecutor({}).executeScript(
      `
      pm.test('empty', function () {
        pm.expect(pm.response.cookies.all()).to.eql([]);
        pm.expect(pm.response.cookies.toObject()).to.eql({});
        pm.expect(pm.response.headers.get('content-type')).to.equal('text/plain');
        pm.expect(pm.response.headers.get('X-Missing')).to.equal(undefined);
        pm.expect(pm.response.headers.has('Content-Type')).to.equal(true);
        pm.expect(pm.response.headers.has('content-type', 'text/html')).to.equal(false);
        pm.expect(pm.response.headers.toObject()).to.eql({ 'content-type': 'text/plain' });
        pm.expect(response.setCookies).to.eql([]);
        pm.expect('set-cookie' in response.headers).to.equal(false);
      });
    `,
      { response: responseWith({ 'content-type': 'text/plain' }) }
    );
    expect(result.errors).toEqual([]);
    expect(result.tests?.every((t) => t.passed)).toBe(true);
  });

  it('accessors outside a test script (no response) return empty values', async () => {
    const result = await new ScriptExecutor({}).executeScript(
      `
      pm.test('no response', function () {
        pm.expect(pm.response.cookies.all()).to.eql([]);
        pm.expect(pm.response.headers.all()).to.eql([]);
        pm.expect(pm.response.headers.get('a')).to.equal(undefined);
        pm.expect(pm.response.headers.toObject()).to.eql({});
      });
    `,
      {}
    );
    expect(result.tests?.every((t) => t.passed)).toBe(true);
  });
});

describe('pm.sendRequest response cookies (#855)', () => {
  it('normalises the sub-response headers and exposes every cookie', async () => {
    const executor = new ScriptExecutor({
      host: {
        sendRequest: async () => ({
          code: 200,
          status: 'OK',
          headers: { 'set-cookie': 'pref=dark', 'content-type': 'text/plain' },
          setCookies: COOKIES,
          body: 'ok',
          responseTime: 1,
          responseSize: 2,
        }),
      },
    });
    const result = await executor.executeScript(
      `
      pm.sendRequest('https://example.com/login', function (err, res) {
        pm.test('sub-response cookies', function () {
          pm.expect(err).to.equal(null);
          pm.expect(res.headers['set-cookie']).to.equal(${JSON.stringify(JOINED)});
          pm.expect(res.headers['content-type']).to.equal('text/plain');
          pm.expect(res.setCookies).to.eql(${JSON.stringify(COOKIES)});
          pm.expect(res.cookies.map(function (c) { return c.name; })).to.eql(['session', 'csrf', 'pref']);
        });
      });
    `,
      {}
    );
    expect(result.errors).toEqual([]);
    expect(result.tests?.map((t) => [t.name, t.passed, t.error])).toEqual([
      ['sub-response cookies', true, undefined],
    ]);
  });
});
