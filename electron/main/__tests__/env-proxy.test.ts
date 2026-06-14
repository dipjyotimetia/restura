import { describe, it, expect } from 'vitest';
import { resolveEnvProxy, matchesNoProxy } from '../security/env-proxy';

describe('matchesNoProxy', () => {
  it('returns false when NO_PROXY is unset or empty', () => {
    expect(matchesNoProxy('example.com', 443, undefined)).toBe(false);
    expect(matchesNoProxy('example.com', 443, '')).toBe(false);
  });

  it('matches everything for a bare *', () => {
    expect(matchesNoProxy('anything.internal', 80, '*')).toBe(true);
  });

  it('matches a host and its subdomains (suffix semantics)', () => {
    expect(matchesNoProxy('example.com', 443, 'example.com')).toBe(true);
    expect(matchesNoProxy('api.example.com', 443, 'example.com')).toBe(true);
    expect(matchesNoProxy('notexample.com', 443, 'example.com')).toBe(false);
  });

  it('accepts a leading dot', () => {
    expect(matchesNoProxy('api.example.com', 443, '.example.com')).toBe(true);
    expect(matchesNoProxy('example.com', 443, '.example.com')).toBe(true);
  });

  it('honours an optional :port qualifier', () => {
    expect(matchesNoProxy('example.com', 8080, 'example.com:8080')).toBe(true);
    expect(matchesNoProxy('example.com', 443, 'example.com:8080')).toBe(false);
  });

  it('splits on commas and whitespace', () => {
    expect(matchesNoProxy('b.com', 443, 'a.com, b.com  c.com')).toBe(true);
  });
});

describe('resolveEnvProxy', () => {
  const target = (u: string) => new URL(u);

  it('returns undefined when no proxy var is set', () => {
    expect(resolveEnvProxy(target('https://example.com'), {})).toBeUndefined();
  });

  it('uses HTTPS_PROXY for https targets and HTTP_PROXY for http targets', () => {
    const env = { HTTPS_PROXY: 'http://proxy:3128', HTTP_PROXY: 'http://other:9999' };
    expect(resolveEnvProxy(target('https://example.com'), env)).toMatchObject({
      type: 'http',
      host: 'proxy',
      port: 3128,
    });
    expect(resolveEnvProxy(target('http://example.com'), env)).toMatchObject({
      host: 'other',
      port: 9999,
    });
  });

  it('falls back to the lowercase var only when the uppercase is unset', () => {
    expect(
      resolveEnvProxy(target('http://example.com'), { http_proxy: 'http://p:1' })
    ).toMatchObject({ host: 'p', port: 1 });
    expect(
      resolveEnvProxy(target('http://example.com'), {
        HTTP_PROXY: 'http://upper:1',
        http_proxy: 'http://lower:2',
      })
    ).toMatchObject({ host: 'upper' });
  });

  it('respects NO_PROXY bypass', () => {
    const env = { HTTPS_PROXY: 'http://proxy:3128', NO_PROXY: 'example.com' };
    expect(resolveEnvProxy(target('https://example.com'), env)).toBeUndefined();
    expect(resolveEnvProxy(target('https://other.com'), env)).toMatchObject({ host: 'proxy' });
  });

  it('parses embedded credentials', () => {
    const env = { HTTP_PROXY: 'http://user:p%40ss@proxy:3128' };
    expect(resolveEnvProxy(target('http://example.com'), env)).toMatchObject({
      host: 'proxy',
      port: 3128,
      auth: { username: 'user', password: 'p@ss' },
    });
  });

  it('defaults the proxy port from its scheme and accepts host-only values', () => {
    expect(
      resolveEnvProxy(target('http://example.com'), { HTTP_PROXY: 'proxy:8080' })
    ).toMatchObject({ type: 'http', host: 'proxy', port: 8080 });
    expect(
      resolveEnvProxy(target('http://example.com'), { HTTP_PROXY: 'https://secure-proxy' })
    ).toMatchObject({ type: 'https', port: 443 });
  });

  it('returns undefined for a malformed proxy URL', () => {
    expect(
      resolveEnvProxy(target('http://example.com'), { HTTP_PROXY: 'http://[bad' })
    ).toBeUndefined();
  });
});
