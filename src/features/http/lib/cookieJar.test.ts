import { describe, expect, it } from 'vitest';
import {
  applySetCookies,
  type CookieItem,
  cookiesForUrl,
  responseCookieHops,
  withJarCookies,
} from './cookieJar';

const NOW = Date.parse('2026-01-01T00:00:00Z');
let n = 0;
const makeId = () => `id-${++n}`;
const store = (jar: CookieItem[], url: string, ...setCookies: string[]) =>
  applySetCookies(jar, [{ url, setCookies }], NOW, makeId);

describe('cookie jar — Max-Age (RFC 6265 §5.2.2)', () => {
  it('deletes a stored cookie on Max-Age=0', () => {
    const jar = store([], 'https://api.example.com/', 'sid=abc');
    expect(jar).toHaveLength(1);
    expect(store(jar, 'https://api.example.com/', 'sid=; Max-Age=0')).toEqual([]);
  });

  it('expires a cookie after Max-Age seconds', () => {
    const jar = store([], 'https://api.example.com/', 'sid=abc; Max-Age=1');
    expect(cookiesForUrl(jar, 'https://api.example.com/', NOW)).toHaveLength(1);
    expect(cookiesForUrl(jar, 'https://api.example.com/', NOW + 1_000)).toHaveLength(0);
  });

  it('lets Max-Age win over Expires', () => {
    const jar = store(
      [],
      'https://api.example.com/',
      'sid=abc; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Max-Age=0'
    );
    expect(jar).toEqual([]);
  });
});

describe('cookie jar — Domain attribute (RFC 6265 §5.3 step 6)', () => {
  it('rejects a Domain the request host does not domain-match', () => {
    expect(store([], 'https://api.example.com/', 'sid=x; Domain=evil.com')).toEqual([]);
  });

  it('rejects a public-suffix Domain', () => {
    expect(store([], 'https://api.example.co.uk/', 'sid=x; Domain=co.uk')).toEqual([]);
    expect(store([], 'https://api.example.com/', 'sid=x; Domain=com')).toEqual([]);
  });

  it('accepts a parent-domain Domain and sends it to subdomains', () => {
    const jar = store([], 'https://api.example.com/', 'sid=x; Domain=.example.com');
    expect(jar[0]).toMatchObject({ domain: 'example.com', hostOnly: false });
    expect(cookiesForUrl(jar, 'https://www.example.com/', NOW)).toHaveLength(1);
  });
});

describe('cookie jar — host-only and default path (RFC 6265 §5.1.4, §5.3)', () => {
  it('does not send a host-only cookie to subdomains', () => {
    const jar = store([], 'https://example.com/', 'sid=x');
    expect(jar[0]).toMatchObject({ domain: 'example.com', hostOnly: true });
    expect(cookiesForUrl(jar, 'https://example.com/', NOW)).toHaveLength(1);
    expect(cookiesForUrl(jar, 'https://sub.example.com/', NOW)).toHaveLength(0);
  });

  it('keeps legacy cookies without the flag matching subdomains', () => {
    const legacy: CookieItem = {
      id: 'l',
      key: 'sid',
      value: 'x',
      domain: 'example.com',
      path: '/',
      secure: false,
      httpOnly: false,
    };
    expect(cookiesForUrl([legacy], 'https://sub.example.com/', NOW)).toHaveLength(1);
  });

  it('defaults the path to the request directory', () => {
    const jar = store([], 'https://api.example.com/v1/users/42', 'sid=x');
    expect(jar[0]?.path).toBe('/v1/users');
    expect(cookiesForUrl(jar, 'https://api.example.com/v1/users/7', NOW)).toHaveLength(1);
    expect(cookiesForUrl(jar, 'https://api.example.com/v2', NOW)).toHaveLength(0);
  });
});

describe('cookie jar — request Cookie header', () => {
  it('merges case-insensitively and lets the user cookie win', () => {
    const out = withJarCookies({ cookie: 'a=user' }, [
      { key: 'a', value: 'jar' },
      { key: 'b', value: '2' },
    ]);
    expect(out).toEqual({ cookie: 'a=user; b=2' });
  });

  it('adds a Cookie header when the user wrote none', () => {
    expect(withJarCookies({}, [{ key: 'a', value: '1' }])).toEqual({ Cookie: 'a=1' });
  });
});

describe('responseCookieHops', () => {
  it('stores final-response cookies against the final URL when no hop list is given', () => {
    expect(
      responseCookieHops(
        { setCookies: ['a=1'], finalUrl: 'https://b.example/x' },
        'https://a.example/'
      )
    ).toEqual([{ url: 'https://b.example/x', setCookies: ['a=1'] }]);
  });
});
