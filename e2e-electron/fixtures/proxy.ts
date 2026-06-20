import { test as electronTest } from './electronApp';
import { startMockHttpServer, type MockHttpServerHandle } from '../../e2e/mocks/httpServer';
import { startMockProxyServer, type MockProxyServerHandle } from '../../e2e/mocks/proxyServer';
import {
  startMockSocksProxyServer,
  type MockSocksProxyHandle,
} from '../../e2e/mocks/socksProxyServer';

/**
 * HTTP forward/CONNECT proxy + an upstream reachable via a NON-bypassed
 * hostname, so the desktop proxy transport is actually exercised. The default
 * proxy bypassList (`localhost`/`127.0.0.1`/`::1`) skips the proxy for loopback,
 * so a plain 127.0.0.1 upstream can never test routing. A `*.localhost`
 * subdomain (RFC 6761) resolves to loopback yet is NOT in the bypass list, so
 * the proxy IS applied — and the SSRF guard still allows it (loopback). The
 * upstream binds dual-stack (`::`) because `upstream.localhost` resolves to ::1
 * first.
 */
export interface ProxyStack {
  /** HTTP forward + CONNECT proxy. */
  proxy: MockProxyServerHandle;
  /** SOCKS5 (no-auth) proxy. */
  socks: MockSocksProxyHandle;
  upstream: MockHttpServerHandle;
  /** Non-bypassed, loopback-resolving upstream origin (host:port via *.localhost). */
  upstreamUrl: string;
}

export const test = electronTest.extend<NonNullable<unknown>, { proxyStack: ProxyStack }>({
  proxyStack: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const [proxy, socks, upstream] = await Promise.all([
        startMockProxyServer(),
        startMockSocksProxyServer(),
        startMockHttpServer({ host: '::' }),
      ]);
      await use({
        proxy,
        socks,
        upstream,
        upstreamUrl: `http://upstream.localhost:${upstream.port}`,
      });
      await Promise.all([proxy.close(), socks.close(), upstream.close()]);
    },
    { scope: 'worker' },
  ],
});

export { expect } from './electronApp';
