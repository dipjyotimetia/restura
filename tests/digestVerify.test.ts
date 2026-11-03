import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DIGEST_REALM, verifyDigest } from '../e2e/mocks/authRoutes';

const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const URL_PATH = '/digest-auth/alice/secret';
const NONCE = 'issued-nonce';

function header(over: Record<string, string> = {}, opts: { uri?: string } = {}) {
  const p = {
    username: 'alice',
    realm: DIGEST_REALM,
    nonce: NONCE,
    uri: opts.uri ?? URL_PATH,
    qop: 'auth',
    nc: '00000001',
    cnonce: 'cn',
    ...over,
  };
  const ha1 = md5(`${p.username}:${p.realm}:secret`);
  const ha2 = md5(`GET:${p.uri}`);
  const response = md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`);
  const all = { ...p, response };
  return `Digest ${Object.entries(all)
    .map(([k, v]) => `${k}="${v}"`)
    .join(', ')}`;
}

const req = (authorization: string, url = URL_PATH) => ({
  method: 'GET',
  url,
  headers: { authorization },
});
const issued = (n: string) => n === NONCE;

describe('mock digest verifier', () => {
  it('accepts a correct qop=auth response', () => {
    expect(verifyDigest(req(header()), 'alice', 'secret', issued)).toBe(true);
  });
  it('rejects a uri that differs from the request URL', () => {
    expect(verifyDigest(req(header({}, { uri: '/other' })), 'alice', 'secret', issued)).toBe(false);
  });
  it('rejects a realm that was not issued', () => {
    expect(verifyDigest(req(header({ realm: 'evil' })), 'alice', 'secret', issued)).toBe(false);
  });
  it('rejects a nonce the mock did not issue', () => {
    expect(verifyDigest(req(header({ nonce: 'forged' })), 'alice', 'secret', issued)).toBe(false);
  });
  it('rejects a response without qop=auth when qop was offered', () => {
    const h = header().replace(/qop="auth", nc="[^"]*", cnonce="[^"]*", /, '');
    expect(verifyDigest(req(h), 'alice', 'secret', issued)).toBe(false);
  });
});
