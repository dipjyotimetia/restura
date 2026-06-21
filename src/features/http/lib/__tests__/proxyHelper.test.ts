import { describe, it, expect, vi } from 'vitest';
import { buildProxyUrl, shouldBypassProxy, formatProxyInfo } from '../proxyHelper';
import type { ProxyConfig } from '@/types';

vi.mock('@/lib/shared/platform', () => ({
  isElectron: () => false,
  getElectronAPI: () => null,
}));

const makeProxy = (overrides: Partial<ProxyConfig> = {}): ProxyConfig => ({
  enabled: true,
  type: 'http',
  host: 'proxy.example.com',
  port: 8080,
  bypassList: [],
  ...overrides,
});

describe('buildProxyUrl', () => {
  it('returns empty string when disabled', () => {
    expect(buildProxyUrl(makeProxy({ enabled: false }))).toBe('');
  });

  it('returns empty string when host is empty', () => {
    expect(buildProxyUrl(makeProxy({ host: '' }))).toBe('');
  });

  it('builds basic proxy URL', () => {
    expect(buildProxyUrl(makeProxy())).toBe('http://proxy.example.com:8080');
  });

  it('includes credentials when provided', () => {
    const proxy = makeProxy({ auth: { username: 'user', password: 'pass' } });
    expect(buildProxyUrl(proxy)).toBe('http://user:pass@proxy.example.com:8080');
  });

  it('encodes special chars in credentials', () => {
    const proxy = makeProxy({ auth: { username: 'u@er', password: 'p@ss' } });
    const url = buildProxyUrl(proxy);
    expect(url).toContain('u%40er');
    expect(url).toContain('p%40ss');
  });

  it('uses socks5 protocol when type is socks5', () => {
    const proxy = makeProxy({ type: 'socks5' });
    expect(buildProxyUrl(proxy)).toBe('socks5://proxy.example.com:8080');
  });
});

describe('shouldBypassProxy', () => {
  it('returns false when bypass list is empty', () => {
    expect(shouldBypassProxy('https://api.example.com', [])).toBe(false);
  });

  it('matches exact hostname', () => {
    expect(shouldBypassProxy('https://api.example.com', ['api.example.com'])).toBe(true);
  });

  it('does not match partial hostname', () => {
    expect(shouldBypassProxy('https://api.example.com', ['example.com'])).toBe(false);
  });

  it('matches wildcard prefix', () => {
    expect(shouldBypassProxy('https://api.example.com', ['*.example.com'])).toBe(true);
  });

  it('does not match wildcard for unrelated domain', () => {
    expect(shouldBypassProxy('https://other.test.com', ['*.example.com'])).toBe(false);
  });

  it('matches glob wildcard pattern', () => {
    expect(shouldBypassProxy('https://192.168.1.1', ['192.168.*'])).toBe(true);
  });
});

describe('formatProxyInfo', () => {
  it('returns disabled message when not enabled', () => {
    const result = formatProxyInfo(makeProxy({ enabled: false }));
    expect(result).toContain('disabled');
  });

  it('returns host:port for enabled proxy', () => {
    const result = formatProxyInfo(makeProxy());
    expect(result).toContain('proxy.example.com');
    expect(result).toContain('8080');
  });
});
