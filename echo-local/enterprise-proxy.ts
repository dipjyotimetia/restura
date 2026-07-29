import { createServer } from 'node:http';
import type { MockProxyServerHandle } from '../e2e/mocks/proxyServer';
import { startMockProxyServer } from '../e2e/mocks/proxyServer';
import {
  type MockSocksProxyHandle,
  startMockSocksProxyServer,
} from '../e2e/mocks/socksProxyServer';
import { PORTS } from './ports';

export const ENTERPRISE_PROXY_USERNAME = 'enterprise-user';
export const ENTERPRISE_PROXY_PASSWORD = 'enterprise-password';

export interface EnterpriseProxyStack {
  proxy: MockProxyServerHandle;
  socks: MockSocksProxyHandle;
  pacUrl: string;
  pacRequestCount(): number;
  close(): Promise<void>;
}

/**
 * PAC server plus an authenticated fallback proxy. The first PAC proxy
 * port is deliberately unbound, so a successful request proves ordered
 * failover reached the second proxy.
 */
export async function startEnterpriseProxyStack(): Promise<EnterpriseProxyStack> {
  let requests = 0;
  const pac = createServer((request, response) => {
    if (request.url !== '/proxy.pac') {
      response.writeHead(404).end();
      return;
    }
    requests++;
    response.writeHead(200, {
      'content-type': 'application/x-ns-proxy-autoconfig',
      'cache-control': 'no-store',
    });
    response.end(
      `function FindProxyForURL(url, host) {
  if (shExpMatch(host, "socks-target.localhost")) return "SOCKS5 127.0.0.1:${PORTS.enterpriseSocks}";
  return "PROXY 127.0.0.1:${PORTS.enterpriseProxyUnavailable}; PROXY 127.0.0.1:${PORTS.enterpriseProxy}";
}\n`
    );
  });
  await new Promise<void>((resolve, reject) => {
    pac.once('error', reject);
    pac.listen(PORTS.enterprisePac, '127.0.0.1', resolve);
  });

  try {
    const proxy = await startMockProxyServer({ port: PORTS.enterpriseProxy });
    let socks: MockSocksProxyHandle;
    try {
      socks = await startMockSocksProxyServer({ port: PORTS.enterpriseSocks });
    } catch (error) {
      await proxy.close();
      throw error;
    }
    proxy.setBasicAuth(ENTERPRISE_PROXY_USERNAME, ENTERPRISE_PROXY_PASSWORD);
    return {
      proxy,
      socks,
      pacUrl: `http://localhost:${PORTS.enterprisePac}/proxy.pac`,
      pacRequestCount: () => requests,
      close: async () => {
        await Promise.all([
          proxy.close(),
          socks.close(),
          new Promise<void>((resolve, reject) =>
            pac.close((error) => (error ? reject(error) : resolve()))
          ),
        ]);
      },
    };
  } catch (error) {
    await new Promise<void>((resolve) => pac.close(() => resolve()));
    throw error;
  }
}
