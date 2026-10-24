import { describe, expect, it } from 'vitest';
import {
  buildSetCookieSideChannel,
  combineSetCookieHeader,
  decodeSetCookieSideChannel,
  encodeSetCookieSideChannel,
  parseResponseSetCookies,
  parseSetCookie,
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
