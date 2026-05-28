import { describe, it, expect } from 'vitest';
import { parseRequestCookies, parseResponseCookies } from '@/lib/shared/cookie-parser';

describe('parseRequestCookies', () => {
  it('returns [] when no Cookie header is present', () => {
    expect(parseRequestCookies({})).toEqual([]);
  });

  it('parses semicolon-separated pairs', () => {
    expect(parseRequestCookies({ cookie: 'a=1; b=2; theme=dark' })).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: '2' },
      { name: 'theme', value: 'dark' },
    ]);
  });

  it('is case-insensitive on the header name', () => {
    expect(parseRequestCookies({ Cookie: 'sid=abc' })).toEqual([{ name: 'sid', value: 'abc' }]);
  });

  it('preserves URL-encoded values verbatim (decoding is the caller\'s problem)', () => {
    expect(parseRequestCookies({ cookie: 'q=hello%20world' })).toEqual([
      { name: 'q', value: 'hello%20world' },
    ]);
  });

  it('drops malformed segments without throwing', () => {
    expect(parseRequestCookies({ cookie: 'a=1; ; =empty; ok=yes' })).toEqual([
      { name: 'a', value: '1' },
      { name: 'ok', value: 'yes' },
    ]);
  });
});

describe('parseResponseCookies', () => {
  it('handles array form (one Set-Cookie per element)', () => {
    const cookies = parseResponseCookies({
      'set-cookie': [
        'session=xyz; Path=/; HttpOnly; Secure; SameSite=Lax',
        'theme=dark; Max-Age=3600',
      ],
    });
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toEqual({
      name: 'session', value: 'xyz', path: '/', httpOnly: true, secure: true, sameSite: 'Lax',
    });
    expect(cookies[1]).toMatchObject({ name: 'theme', value: 'dark', maxAge: 3600 });
  });

  it('splits a concatenated string on cookie boundaries, keeping Expires dates intact', () => {
    const cookies = parseResponseCookies({
      'set-cookie':
        'a=1; Expires=Wed, 09 Jun 2027 10:18:14 GMT; Path=/, b=2; Path=/api',
    });
    expect(cookies.map((c) => c.name)).toEqual(['a', 'b']);
    expect(cookies[0]!.expires).toBe('Wed, 09 Jun 2027 10:18:14 GMT');
    expect(cookies[0]!.path).toBe('/');
    expect(cookies[1]!.path).toBe('/api');
  });

  it('returns [] when no Set-Cookie header is present', () => {
    expect(parseResponseCookies({})).toEqual([]);
  });
});
