import { beforeEach, describe, expect, it } from 'vitest';
import { type CookieItem, useCookieStore } from '../useCookieStore';

function makeCookie(overrides: Partial<CookieItem> & Pick<CookieItem, 'domain'>): CookieItem {
  return {
    id: `${overrides.domain}-${overrides.key ?? 'k'}-${overrides.path ?? '/'}`,
    key: 'sid',
    value: 'abc',
    path: '/',
    secure: false,
    httpOnly: false,
    ...overrides,
  };
}

function seed(cookies: CookieItem[]) {
  useCookieStore.setState({ cookies });
}

function namesFor(url: string): string[] {
  return useCookieStore
    .getState()
    .getCookiesForUrl(url)
    .map((c) => `${c.domain}${c.path}:${c.key}`);
}

describe('useCookieStore.getCookiesForUrl — RFC 6265 matching', () => {
  beforeEach(() => seed([]));

  it('returns a cookie on an exact-host match', () => {
    seed([makeCookie({ domain: 'example.com', key: 'sid' })]);
    expect(namesFor('https://example.com/')).toEqual(['example.com/:sid']);
  });

  it('returns a parent-domain cookie to a subdomain', () => {
    seed([makeCookie({ domain: 'example.com', key: 'sid' })]);
    expect(namesFor('https://api.example.com/')).toEqual(['example.com/:sid']);
  });

  it('does NOT send an example.com cookie across a public-suffix boundary (example.com.evil.com)', () => {
    seed([makeCookie({ domain: 'example.com', key: 'sid' })]);
    expect(namesFor('https://example.com.evil.com/')).toEqual([]);
  });

  it('does NOT send a cookie scoped to a bare public suffix (com) to sites under it', () => {
    seed([makeCookie({ domain: 'com', key: 'leak' })]);
    expect(namesFor('https://example.com/')).toEqual([]);
  });

  it('does NOT send a cookie scoped to a multi-label public suffix (co.uk)', () => {
    seed([makeCookie({ domain: 'co.uk', key: 'leak' })]);
    expect(namesFor('https://example.co.uk/')).toEqual([]);
  });

  it('matches path prefixes at a segment boundary but not /foobar against /foo', () => {
    seed([makeCookie({ domain: 'example.com', key: 'foo', path: '/foo' })]);
    expect(namesFor('https://example.com/foo')).toEqual(['example.com/foo:foo']);
    expect(namesFor('https://example.com/foo/bar')).toEqual(['example.com/foo:foo']);
    expect(namesFor('https://example.com/foobar')).toEqual([]);
  });

  it('withholds a secure-only cookie over http but sends it over https', () => {
    seed([makeCookie({ domain: 'example.com', key: 'sec', secure: true })]);
    expect(namesFor('http://example.com/')).toEqual([]);
    expect(namesFor('https://example.com/')).toEqual(['example.com/:sec']);
  });

  it('still round-trips a host-only localhost cookie (special-use domain)', () => {
    seed([makeCookie({ domain: 'localhost', key: 'dev' })]);
    expect(namesFor('http://localhost/')).toEqual(['localhost/:dev']);
  });

  it('still round-trips a host-only IP cookie to the same IP', () => {
    seed([makeCookie({ domain: '127.0.0.1', key: 'ip' })]);
    expect(namesFor('http://127.0.0.1/')).toEqual(['127.0.0.1/:ip']);
  });

  it('skips expired cookies', () => {
    seed([
      makeCookie({
        domain: 'example.com',
        key: 'old',
        expires: new Date(Date.now() - 1000).toISOString(),
      }),
    ]);
    expect(namesFor('https://example.com/')).toEqual([]);
  });
});
