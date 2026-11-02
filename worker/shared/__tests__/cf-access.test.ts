import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { proxyAuthMiddleware } from '../../app';
import type { Env } from '../../env';
import { resetCfAccessKeyCache } from '../cf-access';

const TEAM = 'acme';
const ISS = `https://${TEAM}.cloudflareaccess.com`;
const AUD = 'aud-tag-123';
const ENV = { REQUIRE_CF_ACCESS: 'true', CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD };

const b64 = (bytes: Uint8Array | string) => Buffer.from(bytes as Uint8Array).toString('base64url');

let keys: CryptoKeyPair;
let other: CryptoKeyPair;
let jwk: JsonWebKey;

const rsa = (): Promise<CryptoKeyPair> =>
  crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  ) as Promise<CryptoKeyPair>;

beforeAll(async () => {
  keys = await rsa();
  other = await rsa();
  jwk = (await crypto.subtle.exportKey('jwk', keys.publicKey)) as JsonWebKey;
});

const now = () => Math.floor(Date.now() / 1000);

async function jwt(
  claims: Record<string, unknown> = {},
  opts: { key?: CryptoKey; header?: Record<string, unknown> } = {}
) {
  const header = { alg: 'RS256', kid: 'k1', ...opts.header };
  const payload = { iss: ISS, aud: [AUD], exp: now() + 300, email: 'a@b.test', ...claims };
  const signed = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    opts.key ?? keys.privateKey,
    new TextEncoder().encode(signed)
  );
  return `${signed}.${b64(new Uint8Array(sig))}`;
}

function call(headers: Record<string, string>, env: Partial<Env> = ENV) {
  const app = new Hono<{ Bindings: Env }>();
  app.use('/api/*', proxyAuthMiddleware);
  app.get('/api/x', (c) => c.text('ok'));
  return app.request('/api/x', { headers }, env as Env);
}

const assertion = (token: string) => ({ 'Cf-Access-Jwt-Assertion': token });

describe('REQUIRE_CF_ACCESS', () => {
  let certs: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetCfAccessKeyCache();
    certs = vi.fn(async () =>
      Response.json({ keys: [{ ...jwk, kid: 'k1', alg: 'RS256', use: 'sig' }] })
    );
    vi.stubGlobal('fetch', certs);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('admits a valid assertion, fetching keys only from the team host', async () => {
    expect((await call(assertion(await jwt()))).status).toBe(200);
    expect(String(certs.mock.calls[0]?.[0])).toBe(`${ISS}/cdn-cgi/access/certs`);
  });

  it('accepts a single-string aud and a full team hostname', async () => {
    const res = await call(assertion(await jwt({ aud: AUD })), {
      ...ENV,
      CF_ACCESS_TEAM_DOMAIN: `${TEAM}.cloudflareaccess.com`,
    });
    expect(res.status).toBe(200);
  });

  it.each([
    ['the email header alone', () => ({ 'Cf-Access-Authenticated-User-Email': 'a@b.test' })],
    ['no credentials', () => ({})],
    ['garbage', () => assertion('not.a.jwt')],
  ])('refuses %s', async (_name, headers) => {
    expect((await call(headers())).status).toBe(401);
  });

  it.each<[string, () => Promise<string>]>([
    ['a wrong audience', () => jwt({ aud: ['other'] })],
    ['a wrong issuer', () => jwt({ iss: 'https://evil.cloudflareaccess.com' })],
    ['an expired token', () => jwt({ exp: now() - 3600 })],
    ['a token with no expiry', () => jwt({ exp: undefined })],
    ['a token not valid yet', () => jwt({ nbf: now() + 3600 })],
    ['a signature from another key', async () => jwt({}, { key: other.privateKey })],
    ['an unknown key id', () => jwt({}, { header: { kid: 'nope' } })],
    ['a non-RS256 algorithm', () => jwt({}, { header: { alg: 'none' } })],
    [
      'a tampered payload',
      async () => {
        const [h, , s] = (await jwt()).split('.');
        return `${h}.${b64(JSON.stringify({ iss: ISS, aud: [AUD], exp: now() + 300, email: 'x' }))}.${s}`;
      },
    ],
    ['an empty signature', async () => `${(await jwt()).split('.').slice(0, 2).join('.')}.`],
  ])('refuses %s', async (_name, token) => {
    expect((await call(assertion(await token()))).status).toBe(401);
  });

  it.each([
    ['audience', { REQUIRE_CF_ACCESS: 'true', CF_ACCESS_TEAM_DOMAIN: TEAM }],
    ['team domain', { REQUIRE_CF_ACCESS: 'true', CF_ACCESS_AUD: AUD }],
    ['a usable team domain', { ...ENV, CF_ACCESS_TEAM_DOMAIN: 'evil.test/x' }],
  ])('fails closed without %s, without contacting anything', async (_name, env) => {
    const res = await call(assertion(await jwt()), env);
    expect(res.status).toBe(503);
    expect(certs).not.toHaveBeenCalled();
  });

  it('refuses when the keys cannot be fetched', async () => {
    certs.mockRejectedValueOnce(new Error('down'));
    expect((await call(assertion(await jwt()))).status).toBe(401);
    certs.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    resetCfAccessKeyCache();
    expect((await call(assertion(await jwt()))).status).toBe(401);
  });

  it('asks for manual redirects, the only non-follow mode workerd supports', async () => {
    await call(assertion(await jwt()));
    expect(certs.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });

  it('refuses a redirected certs response', async () => {
    certs.mockResolvedValueOnce(new Response(null, { status: 302 }));
    expect((await call(assertion(await jwt()))).status).toBe(401);
  });

  it('throttles key fetches while the certs endpoint is failing', async () => {
    certs.mockRejectedValue(new Error('down'));
    for (let i = 0; i < 5; i += 1) await call(assertion(await jwt()));
    expect(certs).toHaveBeenCalledTimes(1);
  });

  it('shares one key fetch across concurrent requests', async () => {
    const token = await jwt();
    const results = await Promise.all([1, 2, 3, 4].map(() => call(assertion(token))));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(certs).toHaveBeenCalledTimes(1);
  });

  it('caches keys, and an unknown key id cannot force a fetch per request', async () => {
    await call(assertion(await jwt()));
    await call(assertion(await jwt()));
    expect(certs).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i += 1) {
      await call(assertion(await jwt({}, { header: { kid: `unknown-${i}` } })));
    }
    expect(certs).toHaveBeenCalledTimes(1);
  });

  it('picks up a rotated key once the refresh window has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    try {
      await call(assertion(await jwt()));
      const rotated = await rsa();
      const rotatedJwk = (await crypto.subtle.exportKey('jwk', rotated.publicKey)) as JsonWebKey;
      certs.mockResolvedValue(Response.json({ keys: [{ ...rotatedJwk, kid: 'k2' }] }));
      vi.setSystemTime(Date.now() + 61_000);
      const token = await jwt({}, { key: rotated.privateKey, header: { kid: 'k2' } });
      expect((await call(assertion(token))).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still prefers a configured proxy token over Access', async () => {
    const env = { ...ENV, WORKER_PROXY_TOKEN: 'tok' };
    expect((await call({ 'X-Restura-Proxy-Token': 'tok' }, env)).status).toBe(200);
    expect((await call(assertion(await jwt()), env)).status).toBe(401);
  });
});
