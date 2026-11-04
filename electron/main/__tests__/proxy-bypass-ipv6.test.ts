import { describe, expect, it } from 'vitest';
import { resolveSseExecutionPolicy } from '../handlers/sse-handler';
import { setExecutionPolicy } from '../security/execution-policy';

/**
 * An IPv6 bypass entry matches the bracketed `URL.hostname` whether it is
 * written `::1` or `[::1]` — the same rule the CLI applies (shared matcher).
 */
function withBypass(bypassList: string[]) {
  setExecutionPolicy({
    security: { allowLocalhost: true, allowPrivateIPs: false },
    proxy: { enabled: true, type: 'http', host: 'proxy.example.test', port: 3128, bypassList },
    timeout: 30_000,
    tls: { verifySsl: true, serverCipherOrder: false },
    certificates: { clientCertificates: [], caCertificates: [] },
  });
}

describe('desktop proxy bypass for IPv6 hosts', () => {
  it.each([['::1'], ['[::1]']])('bypass entry %s sends http://[::1] direct', (entry) => {
    withBypass([entry]);
    expect(resolveSseExecutionPolicy({ url: 'http://[::1]:8080/events' }).proxy).toBeUndefined();
  });

  it('still proxies an IPv6 host that is not listed', () => {
    withBypass(['::2']);
    expect(resolveSseExecutionPolicy({ url: 'http://[::1]:8080/events' }).proxy).toMatchObject({
      host: 'proxy.example.test',
    });
  });
});
