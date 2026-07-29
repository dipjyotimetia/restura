import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { connect as connectTcp } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockHttpServerHandle, startMockHttpServer } from '../../e2e/mocks/httpServer';
import { startMockProxyServer } from '../../e2e/mocks/proxyServer';
import { type EchoCerts, ensureCerts } from '../../echo-local/certs';
import {
  ENTERPRISE_PROXY_PASSWORD,
  ENTERPRISE_PROXY_USERNAME,
  type EnterpriseProxyStack,
  startEnterpriseProxyStack,
} from '../../echo-local/enterprise-proxy';
import { PORTS } from '../../echo-local/ports';
import {
  createOrderedPacProxyAgent,
  type OrderedPacProxyAgent,
} from '../../electron/main/security/ordered-pac-agent';

function request(url: string, agent: OrderedPacProxyAgent): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpGet(url, { agent }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    req.once('error', reject);
  });
}

describe('Echo Local enterprise PAC stack', () => {
  const certDir = mkdtempSync(path.join(tmpdir(), 'restura-enterprise-certs-'));
  let certs: EchoCerts;
  let upstream: MockHttpServerHandle;
  let stack: EnterpriseProxyStack;

  beforeAll(async () => {
    certs = ensureCerts({ dir: certDir });
    [upstream, stack] = await Promise.all([
      startMockHttpServer({ host: '::' }),
      startEnterpriseProxyStack(certs),
    ]);
  });

  afterAll(async () => {
    await Promise.all([upstream.close(), stack.close()]);
    rmSync(certDir, { recursive: true, force: true });
  });

  it('serves its PAC over the generated enterprise CA', async () => {
    const body = await new Promise<string>((resolve, reject) => {
      httpsGet(stack.pacUrl, { ca: certs.caPem }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      }).once('error', reject);
    });

    expect(body).toContain(`PROXY 127.0.0.1:${PORTS.enterpriseProxyUnavailable}`);
    expect(body).toContain(`PROXY 127.0.0.1:${PORTS.enterpriseProxy}`);
    expect(body).toContain(`SOCKS5 127.0.0.1:${PORTS.enterpriseSocks}`);
  });

  it('falls back from the unavailable proxy and authenticates the second proxy', async () => {
    const authorization = `Basic ${Buffer.from(
      `${ENTERPRISE_PROXY_USERNAME}:${ENTERPRISE_PROXY_PASSWORD}`
    ).toString('base64')}`;
    const agent = createOrderedPacProxyAgent(
      async () =>
        `PROXY 127.0.0.1:${PORTS.enterpriseProxyUnavailable}; PROXY 127.0.0.1:${PORTS.enterpriseProxy}`,
      {
        fallbackToDirect: false,
        originalAgent: false,
        lookupProxyAuthorization: async (proxyUrl) =>
          proxyUrl.includes(`:${PORTS.enterpriseProxy}`) ? authorization : undefined,
      }
    );

    await expect(
      request(`http://enterprise-target.localhost:${upstream.port}/json`, agent)
    ).resolves.toBe(200);
    expect(stack.proxy.connectCount()).toBeGreaterThanOrEqual(1);
    agent.destroy();
  });

  it('bounds a rejected Basic challenge and advances to the next proxy', async () => {
    const wrongProxy = await startMockProxyServer({ port: 0 });
    wrongProxy.setBasicAuth('different-user', 'different-password');
    const authorization = `Basic ${Buffer.from(
      `${ENTERPRISE_PROXY_USERNAME}:${ENTERPRISE_PROXY_PASSWORD}`
    ).toString('base64')}`;
    const agent = createOrderedPacProxyAgent(
      async () => `PROXY 127.0.0.1:${wrongProxy.port}; PROXY 127.0.0.1:${PORTS.enterpriseProxy}`,
      {
        fallbackToDirect: false,
        originalAgent: false,
        lookupProxyAuthorization: async () => authorization,
      }
    );

    try {
      await expect(
        request(`http://enterprise-target.localhost:${upstream.port}/json`, agent)
      ).resolves.toBe(200);
      expect(wrongProxy.authChallengeCount()).toBe(1);
    } finally {
      agent.destroy();
      await wrongProxy.close();
    }
  });

  it('uses an explicitly pinned DIRECT fallback when policy permits it', async () => {
    const agent = createOrderedPacProxyAgent(
      async () => `PROXY 127.0.0.1:${PORTS.enterpriseProxyUnavailable}; DIRECT`,
      { fallbackToDirect: false, originalAgent: false },
      async (_request, options) => {
        const socket = connectTcp({ host: '127.0.0.1', port: options.port });
        await once(socket, 'connect');
        return socket;
      }
    );

    await expect(
      request(`http://enterprise-target.localhost:${upstream.port}/json`, agent)
    ).resolves.toBe(200);
    agent.destroy();
  });

  it('routes a host-selected PAC result through SOCKS5', async () => {
    const agent = createOrderedPacProxyAgent(
      async () => `SOCKS5 127.0.0.1:${PORTS.enterpriseSocks}`,
      {
        fallbackToDirect: false,
        originalAgent: false,
      }
    );
    const before = stack.socks.connectCount();

    await expect(
      request(`http://socks-target.localhost:${upstream.port}/json`, agent)
    ).resolves.toBe(200);
    expect(stack.socks.connectCount()).toBeGreaterThan(before);
    agent.destroy();
  });
});
