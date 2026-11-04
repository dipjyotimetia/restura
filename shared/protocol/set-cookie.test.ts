import { describe, expect, it } from 'vitest';
import {
  applyChainCookies,
  buildCookieHopsSideChannel,
  buildSetCookieSideChannel,
  combineSetCookieHeader,
  cookieMatchesUrl,
  decodeCookieHopsSideChannel,
  decodeSetCookieSideChannel,
  defaultCookiePath,
  encodeSetCookieSideChannel,
  parseResponseSetCookies,
  parseSetCookie,
  RedirectCookieChain,
  resolveSetCookie,
  responseHeaderEntries,
  responseSetCookies,
  SET_COOKIE_OMITTED_HEADER,
  SET_COOKIE_SIDE_CHANNEL_MAX_BYTES,
  splitFoldedSetCookie,
} from './set-cookie';

const COOKIES = [
  'session=abc; Path=/; HttpOnly',
  'csrf=xyz; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Secure',
  'pref=dark',
];

describe('responseSetCookies', () => {
  it('prefers the authoritative list over the flat header', () => {
    expect(
      responseSetCookies({ headers: { 'set-cookie': 'pref=dark' }, setCookies: COOKIES })
    ).toBe(COOKIES);
  });

  it('falls back to an array header value', () => {
    expect(responseSetCookies({ headers: { 'Set-Cookie': ['a=1', 'b=2'] } })).toEqual([
      'a=1',
      'b=2',
    ]);
  });

  it('splits a legacy folded header without breaking Expires dates', () => {
    expect(responseSetCookies({ headers: { 'set-cookie': COOKIES.join(', ') } })).toEqual(COOKIES);
  });

  it('returns [] when there is no cookie, and ignores an empty list', () => {
    expect(responseSetCookies({ headers: { a: 'b' } })).toEqual([]);
    expect(responseSetCookies({ headers: { 'set-cookie': 'x=1' }, setCookies: [] })).toEqual([
      'x=1',
    ]);
  });
});

describe('splitFoldedSetCookie', () => {
  it('splits only before name= tokens and drops empty input', () => {
    expect(splitFoldedSetCookie('a=1, b=2; Expires=Wed, 21 Oct 2037')).toEqual([
      'a=1',
      'b=2; Expires=Wed, 21 Oct 2037',
    ]);
    expect(splitFoldedSetCookie('  ')).toEqual([]);
  });
});

describe('responseHeaderEntries', () => {
  it('renders one row per cookie in the set-cookie position', () => {
    expect(
      responseHeaderEntries({
        headers: { 'content-type': 'text/plain', 'set-cookie': 'pref=dark', 'x-multi': ['1', '2'] },
        setCookies: ['a=1', 'b=2'],
      })
    ).toEqual([
      ['content-type', 'text/plain'],
      ['set-cookie', 'a=1'],
      ['set-cookie', 'b=2'],
      ['x-multi', '1'],
      ['x-multi', '2'],
    ]);
  });

  it('appends cookies when the flat map has no set-cookie key (stripped side-channel path)', () => {
    expect(responseHeaderEntries({ headers: { a: 'b' }, setCookies: ['c=1'] })).toEqual([
      ['a', 'b'],
      ['set-cookie', 'c=1'],
    ]);
  });

  it('places cookies once even if the map has two set-cookie spellings', () => {
    expect(
      responseHeaderEntries({
        headers: { 'set-cookie': 'a=1', 'Set-Cookie': 'b=2' },
        setCookies: ['a=1', 'b=2'],
      })
    ).toEqual([
      ['set-cookie', 'a=1'],
      ['set-cookie', 'b=2'],
    ]);
  });
});

describe('combineSetCookieHeader', () => {
  it('joins every cookie under a lower-case set-cookie key', () => {
    expect(
      combineSetCookieHeader({ 'content-type': 'x', 'Set-Cookie': 'pref=dark' }, COOKIES)
    ).toEqual({ 'content-type': 'x', 'set-cookie': COOKIES.join(', ') });
  });

  it('leaves a cookie-less map without set-cookie', () => {
    expect(combineSetCookieHeader({ a: 'b' }, undefined)).toEqual({ a: 'b' });
  });
});

describe('parseSetCookie', () => {
  it('parses name, value and every attribute', () => {
    expect(
      parseSetCookie(
        'sid=a=b; Domain=example.com; Path=/p; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Max-Age=60; HttpOnly; Secure; SameSite=Lax; Priority=High'
      )
    ).toEqual({
      name: 'sid',
      value: 'a=b',
      domain: 'example.com',
      path: '/p',
      expires: 'Wed, 21 Oct 2037 07:28:00 GMT',
      maxAge: 60,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    });
  });

  it('ignores a non-numeric or empty Max-Age', () => {
    expect(parseSetCookie('a=1; Max-Age=soon')).toEqual({ name: 'a', value: '1' });
    expect(parseSetCookie('a=1; Max-Age=')).toEqual({ name: 'a', value: '1' });
  });

  it('rejects fields without a name=value pair', () => {
    expect(parseSetCookie('')).toBeNull();
    expect(parseSetCookie('[REDACTED]')).toBeNull();
    expect(parseSetCookie('=value')).toBeNull();
  });

  it('parseResponseSetCookies drops unparseable fields', () => {
    expect(
      parseResponseSetCookies({ headers: {}, setCookies: ['a=1', 'junk'] }).map((c) => c.name)
    ).toEqual(['a']);
  });
});

describe('set-cookie side channel', () => {
  it('round-trips cookies, escaping non-ASCII into a ByteString-safe value', () => {
    const cookies = ['a=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT', 'name=café☃', 'q="x"'];
    const encoded = encodeSetCookieSideChannel(cookies);
    expect(encoded).toMatch(/^[\x20-\x7e]*$/);
    expect(() => new Headers({ 'x-test': encoded })).not.toThrow();
    expect(decodeSetCookieSideChannel(encoded)).toEqual(cookies);
  });

  it('decodes absent or malformed values to []', () => {
    expect(decodeSetCookieSideChannel(null)).toEqual([]);
    expect(decodeSetCookieSideChannel(undefined)).toEqual([]);
    expect(decodeSetCookieSideChannel('')).toEqual([]);
    expect(decodeSetCookieSideChannel('not json')).toEqual([]);
    expect(decodeSetCookieSideChannel('{"a":1}')).toEqual([]);
    expect(decodeSetCookieSideChannel('["a=1", 2, null]')).toEqual(['a=1']);
  });
});

describe('set-cookie side channel size cap', () => {
  it('encodeSetCookieSideChannel alone is unbounded (60 x 4KB > 16KB)', () => {
    const cookies = Array.from({ length: 60 }, (_, i) => `c${i}=${'v'.repeat(4096)}; Path=/`);
    expect(encodeSetCookieSideChannel(cookies).length).toBeGreaterThan(16 * 1024);
  });

  it('buildSetCookieSideChannel caps the header and reports omitted cookies', () => {
    const cookies = Array.from({ length: 60 }, (_, i) => `c${i}=${'v'.repeat(4096)}; Path=/`);
    const { value, omitted } = buildSetCookieSideChannel(cookies);
    expect(value.length).toBeLessThanOrEqual(SET_COOKIE_SIDE_CHANNEL_MAX_BYTES);
    const kept = decodeSetCookieSideChannel(value);
    expect(kept).toEqual(cookies.slice(0, kept.length));
    expect(kept.length).toBeGreaterThan(0);
    expect(omitted).toBe(60 - kept.length);
    expect(SET_COOKIE_OMITTED_HEADER).toBe('x-restura-set-cookies-omitted');
  });

  it('keeps everything and reports 0 omitted when under the cap', () => {
    const cookies = ['a=1', 'b=2'];
    const { value, omitted } = buildSetCookieSideChannel(cookies);
    expect(omitted).toBe(0);
    expect(decodeSetCookieSideChannel(value)).toEqual(cookies);
  });

  it('skips an individually oversized cookie but keeps later ones that fit', () => {
    const { value, omitted } = buildSetCookieSideChannel([
      'a=1',
      `big=${'x'.repeat(20000)}`,
      'b=2',
    ]);
    expect(omitted).toBe(1);
    expect(decodeSetCookieSideChannel(value)).toEqual(['a=1', 'b=2']);
  });
});

describe('cookie-hops side channel', () => {
  const hop = (url: string, ...setCookies: string[]) => ({ url, setCookies });

  it('carries nothing when there is no final URL and no hop', () => {
    expect(buildCookieHopsSideChannel({})).toEqual({ value: undefined, omitted: 0 });
    expect(buildCookieHopsSideChannel({ cookieHops: [] })).toEqual({
      value: undefined,
      omitted: 0,
    });
  });

  it('round-trips the final URL and every hop when it fits', () => {
    const fields = {
      finalUrl: 'https://b.test/done',
      cookieHops: [hop('https://a.test/', 'a=1'), hop('https://b.test/', 'b=2', 'c=3')],
    };
    const { value, omitted } = buildCookieHopsSideChannel(fields);
    expect(omitted).toBe(0);
    expect(decodeCookieHopsSideChannel(value)).toEqual(fields);
  });

  it('drops cookies that do not fit (and a hop left empty) without a final URL', () => {
    const big = `big=${'x'.repeat(400)}`;
    const { value, omitted } = buildCookieHopsSideChannel(
      { cookieHops: [hop('https://a.test/', big), hop('https://b.test/', 'b=2')] },
      200
    );
    expect(omitted).toBe(1);
    expect(decodeCookieHopsSideChannel(value)).toEqual({
      cookieHops: [hop('https://b.test/', 'b=2')],
    });
  });

  it('carries nothing when the final URL alone exceeds the cap', () => {
    expect(
      buildCookieHopsSideChannel({ finalUrl: `https://a.test/${'p'.repeat(300)}` }, 100)
    ).toEqual({ value: undefined, omitted: 0 });
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['not URI-encoded JSON', '%E0%A4%A'],
    ['a JSON array', encodeURIComponent('[1]')],
    ['a JSON scalar', encodeURIComponent('5')],
    ['JSON null', encodeURIComponent('null')],
  ])('decodes a malformed (%s) value as empty', (_label, value) => {
    expect(decodeCookieHopsSideChannel(value)).toEqual({});
  });

  it('keeps only well-formed hops and string cookies when decoding', () => {
    const value = encodeURIComponent(
      JSON.stringify({
        finalUrl: 42,
        cookieHops: [
          null,
          { url: 1, setCookies: ['x=1'] },
          { url: 'https://a.test/', setCookies: 'x=1' },
          { url: 'https://a.test/', setCookies: [1, 'ok=1'] },
          { url: 'https://b.test/', setCookies: [2] },
        ],
      })
    );
    expect(decodeCookieHopsSideChannel(value)).toEqual({
      cookieHops: [hop('https://a.test/', 'ok=1')],
    });
  });

  it('omits cookieHops entirely when no hop survives decoding', () => {
    const value = encodeURIComponent(JSON.stringify({ finalUrl: 'u', cookieHops: [{}] }));
    expect(decodeCookieHopsSideChannel(value)).toEqual({ finalUrl: 'u' });
  });
});

describe('resolveSetCookie (RFC 6265 storage model)', () => {
  const now = Date.UTC(2030, 0, 1);

  it('refuses a field with no name=value pair and an unparseable request URL', () => {
    expect(resolveSetCookie('novalue', 'https://a.test/', now)).toEqual({
      ok: false,
      reason: 'no name=value pair',
    });
    expect(resolveSetCookie('a=1', 'not a url', now)).toEqual({
      ok: false,
      reason: 'invalid request URL',
    });
  });

  it('keeps SameSite, Secure and HttpOnly and defaults the path to the request directory', () => {
    const r = resolveSetCookie(
      'sid=1; SameSite=Lax; Secure; HttpOnly',
      'https://API.a.test/v1/users/me',
      now
    );
    expect(r).toEqual({
      ok: true,
      cookie: {
        name: 'sid',
        value: '1',
        domain: 'api.a.test',
        hostOnly: true,
        path: '/v1/users',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
    });
  });

  it('a relative Path attribute falls back to the default path', () => {
    const r = resolveSetCookie('a=1; Path=relative', 'https://a.test/x/y', now);
    expect(r.ok && r.cookie.path).toBe('/x');
  });

  it('refuses a Domain the host does not match and a single-label public suffix', () => {
    expect(resolveSetCookie('a=1; Domain=other.test', 'https://a.test/', now)).toMatchObject({
      ok: false,
      reason: 'Domain=other.test does not match a.test',
    });
    expect(resolveSetCookie('a=1; Domain=test', 'https://a.test/', now)).toMatchObject({
      ok: false,
      reason: 'Domain=test is a public suffix',
    });
  });

  it('Max-Age wins over Expires; Max-Age<=0 deletes; an unparseable Expires is a session cookie', () => {
    const expiresIn = (raw: string) => {
      const r = resolveSetCookie(raw, 'https://a.test/', now);
      return r.ok ? r.cookie.expiresAt : 'refused';
    };
    expect(expiresIn('a=1; Max-Age=60; Expires=Wed, 21 Oct 2037 07:28:00 GMT')).toBe(now + 60_000);
    expect(expiresIn('a=1; Max-Age=0')).toBe(Number.NEGATIVE_INFINITY);
    expect(expiresIn('a=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT')).toBe(
      Date.UTC(2037, 9, 21, 7, 28)
    );
    expect(expiresIn('a=1; Expires=someday')).toBeUndefined();
  });
});

describe('cookie path and URL matching edge cases', () => {
  it('a URL whose path is not absolute defaults to the root path', () => {
    expect(defaultCookiePath(new URL('urn:example:thing'))).toBe('/');
  });

  it('an empty URL path matches a root-path cookie', () => {
    const cookie = { domain: 'host', hostOnly: true, path: '/', secure: false };
    expect(cookieMatchesUrl(cookie, new URL('foo://host'), 0)).toBe(true);
  });
});

describe('applyChainCookies', () => {
  it('replaces a repeated outgoing name once with the chain value', () => {
    expect(applyChainCookies('a=1; b=2; a=3', [{ name: 'a', value: 'new' }], new Set())).toBe(
      'a=new; b=2'
    );
  });

  it('drops deleted names, keeps others and appends chain-only cookies', () => {
    expect(
      applyChainCookies(
        'gone=1; keep=2;;',
        [
          { name: 'x', value: 'long-path' },
          { name: 'x', value: 'short-path' },
        ],
        new Set(['gone'])
      )
    ).toBe('keep=2; x=long-path');
  });

  it('builds a header from chain cookies alone', () => {
    expect(applyChainCookies(undefined, [{ name: 'a', value: '1' }], new Set())).toBe('a=1');
  });
});

describe('RedirectCookieChain', () => {
  const now = Date.UTC(2030, 0, 1);

  it('skips unresolvable fields but still records the hop', () => {
    const chain = new RedirectCookieChain();
    chain.record('https://a.test/', ['novalue', 'a=1; Domain=evil.test'], now);
    expect(chain.hops).toEqual([
      { url: 'https://a.test/', setCookies: ['novalue', 'a=1; Domain=evil.test'] },
    ]);
    expect(chain.matching('https://a.test/', now)).toEqual([]);
    expect(chain.responses).toBe(1);
  });

  it('keeps same-name cookies with different paths or domains apart, longest path first', () => {
    const chain = new RedirectCookieChain();
    chain.record(
      'https://www.a.test/app/page',
      ['a=root; Path=/', 'a=app; Path=/app', 'a=dom; Domain=a.test; Path=/'],
      now
    );
    chain.record('https://www.a.test/app/next', ['a=app2; Path=/app'], now);
    expect(chain.matching('https://www.a.test/app/x', now).map((c) => c.value)).toEqual([
      'app2',
      'root',
      'dom',
    ]);
    expect(chain.lastUrl).toBe('https://www.a.test/app/next');
  });

  it('reports a deleted cookie for matching URLs only, and forgets it when re-set', () => {
    const chain = new RedirectCookieChain();
    expect(chain.deletedNames('https://a.test/')).toEqual(new Set());
    chain.record('https://a.test/', ['s=1', 's=; Max-Age=0'], now);
    expect(chain.deletedNames('https://a.test/x')).toEqual(new Set(['s']));
    expect(chain.deletedNames('https://other.test/')).toEqual(new Set());
    expect(chain.deletedNames('not a url')).toEqual(new Set());
    expect(chain.matching('https://a.test/', now)).toEqual([]);
    chain.record('https://a.test/', ['s=2'], now);
    expect(chain.deletedNames('https://a.test/')).toEqual(new Set());
    expect(chain.matching('not a url', now)).toEqual([]);
  });
});
