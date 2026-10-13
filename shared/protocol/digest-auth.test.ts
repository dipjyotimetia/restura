import { describe, expect, it } from 'vitest';
import { md5Hex } from './crypto-utils';
import { buildDigestAuthorization, selectDigestChallenge } from './digest-auth';

/** Pull `name=value` / `name="value"` params back out of an Authorization header. */
function params(header: string): Record<string, string> {
  expect(header.startsWith('Digest ')).toBe(true);
  const out: Record<string, string> = {};
  const re = /([a-z]+)=(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/gi;
  for (const m of header.slice(7).matchAll(re)) {
    out[m[1]!.toLowerCase()] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3]!;
  }
  return out;
}

describe('selectDigestChallenge', () => {
  it('returns null when there is no Digest challenge', () => {
    expect(selectDigestChallenge(['Basic realm="x"'])).toBeNull();
    expect(selectDigestChallenge([])).toBeNull();
    expect(selectDigestChallenge(['Bearer realm="api", error="invalid_token"'])).toBeNull();
  });

  it('parses quoted-string params including escaped quotes and commas', () => {
    const c = selectDigestChallenge([
      'Digest realm="a \\"quoted\\", realm", nonce="n1", qop="auth,auth-int", opaque="op"',
    ]);
    expect(c).toMatchObject({ realm: 'a "quoted", realm', nonce: 'n1', opaque: 'op' });
    expect(c?.qop).toEqual(['auth', 'auth-int']);
  });

  it('picks the strongest supported Digest challenge across several headers / one folded header', () => {
    const folded =
      'Basic realm="b", Digest realm="r", nonce="md5n", algorithm=MD5, qop="auth", ' +
      'Digest realm="r", nonce="shan", algorithm=SHA-256, qop="auth"';
    expect(selectDigestChallenge([folded])?.nonce).toBe('shan');
    expect(
      selectDigestChallenge([
        'Digest realm="r", nonce="md5n", algorithm=MD5',
        'Digest realm="r", nonce="shan", algorithm=SHA-256',
      ])?.algorithm
    ).toBe('SHA-256');
  });

  it('ignores challenges with an unsupported algorithm or a missing nonce', () => {
    expect(
      selectDigestChallenge(['Digest realm="r", nonce="n", algorithm=SHA-512-256'])
    ).toBeNull();
    expect(selectDigestChallenge(['Digest realm="r"'])).toBeNull();
  });

  it('ignores challenges that only offer qop=auth-int', () => {
    expect(selectDigestChallenge(['Digest realm="r", nonce="n", qop="auth-int"'])).toBeNull();
  });
});

describe('buildDigestAuthorization', () => {
  // RFC 7616 §3.9.1 worked example.
  const rfc7616 = {
    realm: 'http-auth@example.org',
    nonce: '7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v',
    opaque: 'FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS',
    qop: ['auth', 'auth-int'],
  };
  const creds = { username: 'Mufasa', password: 'Circle of Life' };
  const cnonce = 'f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ';

  it('computes the RFC 7616 MD5 response', async () => {
    const h = await buildDigestAuthorization(
      { ...rfc7616, algorithm: 'MD5' },
      creds,
      { method: 'GET', uri: '/dir/index.html' },
      { cnonce }
    );
    const p = params(h);
    expect(p.response).toBe('8ca523f5e9506fed4657c9700eebdbec');
    expect(p).toMatchObject({
      username: 'Mufasa',
      realm: 'http-auth@example.org',
      uri: '/dir/index.html',
      qop: 'auth',
      nc: '00000001',
      cnonce,
      opaque: rfc7616.opaque,
      algorithm: 'MD5',
    });
  });

  it('computes the RFC 7616 SHA-256 response', async () => {
    const h = await buildDigestAuthorization(
      { ...rfc7616, algorithm: 'SHA-256' },
      creds,
      { method: 'GET', uri: '/dir/index.html' },
      { cnonce }
    );
    expect(params(h).response).toBe(
      '753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1'
    );
  });

  // RFC 2617 §3.5 uses "Circle Of Life" (capital O), unlike RFC 7616.
  const rfc2617Creds = { username: 'Mufasa', password: 'Circle Of Life' };

  it('computes the RFC 2617 legacy (no qop) response', async () => {
    const h = await buildDigestAuthorization(
      { realm: 'testrealm@host.com', nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093' },
      rfc2617Creds,
      { method: 'GET', uri: '/dir/index.html' },
      { cnonce: '0a4f113b' }
    );
    const p = params(h);
    // RFC 2069-compatible: no qop/nc/cnonce on the wire.
    expect(p.response).toBe('670fd8c2df070c60b045671b8b24ff02');
    expect(p.qop).toBeUndefined();
    expect(p.nc).toBeUndefined();
  });

  it('computes the RFC 2617 qop=auth response', async () => {
    const h = await buildDigestAuthorization(
      {
        realm: 'testrealm@host.com',
        nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093',
        qop: ['auth'],
        opaque: '5ccc069c403ebaf9f0171e9517f40e41',
      },
      rfc2617Creds,
      { method: 'GET', uri: '/dir/index.html' },
      { cnonce: '0a4f113b' }
    );
    expect(params(h).response).toBe('6629fae49393a05397450978507c4ef1');
  });

  it('MD5-sess folds nonce and cnonce into HA1', async () => {
    const base = { realm: 'r', nonce: 'n', qop: ['auth'] };
    const plain = params(
      await buildDigestAuthorization(
        { ...base, algorithm: 'MD5' },
        creds,
        {
          method: 'GET',
          uri: '/',
        },
        { cnonce: 'c' }
      )
    );
    const sess = params(
      await buildDigestAuthorization(
        { ...base, algorithm: 'MD5-sess' },
        creds,
        {
          method: 'GET',
          uri: '/',
        },
        { cnonce: 'c' }
      )
    );
    // HA1 = MD5(MD5(user:realm:pass):n:c); response = MD5(HA1:n:00000001:c:auth:MD5(GET:/))
    const ha1 = md5Hex(`${md5Hex('Mufasa:r:Circle of Life')}:n:c`);
    const expected = md5Hex(`${ha1}:n:00000001:c:auth:${md5Hex('GET:/')}`);
    expect(sess.response).toBe(expected);
    expect(sess.response).not.toBe(plain.response);
    expect(sess.algorithm).toBe('MD5-sess');
  });

  it('generates a random cnonce when none is supplied and never emits the password', async () => {
    const a = await buildDigestAuthorization({ realm: 'r', nonce: 'n', qop: ['auth'] }, creds, {
      method: 'GET',
      uri: '/',
    });
    const b = await buildDigestAuthorization({ realm: 'r', nonce: 'n', qop: ['auth'] }, creds, {
      method: 'GET',
      uri: '/',
    });
    expect(params(a).cnonce).toMatch(/^[0-9a-f]{32}$/);
    expect(params(a).cnonce).not.toBe(params(b).cnonce);
    expect(a).not.toContain('Circle of Life');
  });

  it('escapes quotes in the username', async () => {
    const h = await buildDigestAuthorization(
      { realm: 'r', nonce: 'n', qop: ['auth'] },
      { username: 'a"b\\c', password: 'p' },
      { method: 'GET', uri: '/' },
      { cnonce: 'c' }
    );
    expect(h).toContain('username="a\\"b\\\\c"');
  });
});
