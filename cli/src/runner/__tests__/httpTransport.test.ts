import type { LookupAddress } from 'node:dns';
import type { RequestSettingsOverride } from '@shared/types';
import { ProxyAgent } from 'undici';
import { describe, expect, it } from 'vitest';
import { guardedProxyLookup, requestDispatcher } from '../executors/http-transport';

function proxySettings(bypassList: string[], host = 'proxy.example.test'): RequestSettingsOverride {
  return {
    proxy: { enabled: true, type: 'http', host, port: 3128, bypassList },
  } as RequestSettingsOverride;
}

async function usesProxy(
  settings: RequestSettingsOverride,
  url: string,
  allowLocalhost = false
): Promise<boolean> {
  const result = requestDispatcher(settings, url, { allowLocalhost });
  if (!result.ok) throw new Error(result.error);
  const proxied = result.dispatcher instanceof ProxyAgent;
  await result.dispatcher?.close();
  return proxied;
}

describe('CLI per-request proxy bypass for IPv6 hosts', () => {
  it.each([['::1'], ['[::1]']])('bypass entry %s sends http://[::1] direct', async (entry) => {
    expect(await usesProxy(proxySettings([entry]), 'http://[::1]:8080/x')).toBe(false);
  });

  it('still proxies an IPv6 host that is not listed', async () => {
    expect(await usesProxy(proxySettings(['::2']), 'http://[::1]:8080/x')).toBe(true);
  });
});

describe('security: a collection proxy host cannot point at an internal address', () => {
  const target = 'https://api.example.com/x';

  it.each([
    ['cloud metadata', '169.254.169.254', true],
    ['cloud metadata (IPv6)', 'fd00:ec2::254', true],
    ['metadata host name', 'metadata.google.internal', true],
    ['RFC1918', '10.0.0.5', true],
    ['RFC1918 192.168', '192.168.1.10', true],
    ['link-local', '169.254.10.10', true],
    ['loopback without --allow-localhost', '127.0.0.1', false],
    ['localhost without --allow-localhost', 'localhost', false],
  ])('refuses a %s proxy (%s)', (_label, host, allowLocalhost) => {
    const result = requestDispatcher(proxySettings([], host), target, { allowLocalhost });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/proxy host .* is not allowed.*not sent/);
  });

  it('allows a loopback proxy with --allow-localhost', async () => {
    expect(await usesProxy(proxySettings([], '127.0.0.1'), target, true)).toBe(true);
  });

  it('allows a public proxy host', async () => {
    expect(await usesProxy(proxySettings([], 'proxy.example.com'), target)).toBe(true);
  });

  it('refuses a proxy name that resolves to loopback unless localhost is allowed', async () => {
    const resolve = (allow: boolean) =>
      new Promise<{ err: Error | null; records: LookupAddress[] }>((done) =>
        guardedProxyLookup(allow)('localhost', { all: true }, (err, records) =>
          done({ err: err as Error | null, records: records as LookupAddress[] })
        )
      );
    const refused = await resolve(false);
    expect(refused.err?.message).toMatch(/loopback/);
    const allowed = await resolve(true);
    expect(allowed.err).toBeNull();
    expect(allowed.records.length).toBeGreaterThan(0);
  });
});
