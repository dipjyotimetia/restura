import { once } from 'node:events';
import { get as httpGet } from 'node:http';
import { connect as connectTcp, createServer, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockHttpServerHandle, startMockHttpServer } from '../../e2e/mocks/httpServer';
import { startMockProxyServer } from '../../e2e/mocks/proxyServer';
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

async function startMultiRoundNegotiateProxy(): Promise<{
  port: number;
  connectionCount: () => number;
  authorizations: () => string[];
  close: () => Promise<void>;
}> {
  let connectionCount = 0;
  const authorizations: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    connectionCount += 1;
    sockets.add(client);
    client.once('close', () => sockets.delete(client));
    let buffered = Buffer.alloc(0);
    let rounds = 0;
    let upstreamSocket: Socket | undefined;
    client.on('data', (chunk) => {
      if (upstreamSocket) {
        upstreamSocket.write(chunk);
        return;
      }
      buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
      const headerEnd = buffered.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = buffered.subarray(0, headerEnd).toString('latin1');
      buffered = buffered.subarray(headerEnd + 4);
      authorizations.push(/^Proxy-Authorization:\s*(.+)$/im.exec(header)?.[1] ?? '');
      rounds += 1;
      if (rounds < 3) {
        client.write(
          `HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Negotiate server-${rounds}\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n`
        );
        return;
      }
      const target = /^CONNECT\s+[^:]+:(\d+)\s+/i.exec(header);
      if (!target) {
        client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
      }
      upstreamSocket = connectTcp({ host: '127.0.0.1', port: Number(target[1]) });
      sockets.add(upstreamSocket);
      upstreamSocket.once('close', () => sockets.delete(upstreamSocket!));
      upstreamSocket.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (buffered.length) upstreamSocket?.write(buffered);
        upstreamSocket?.pipe(client);
      });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Negotiate proxy did not bind');
  return {
    port: address.port,
    connectionCount: () => connectionCount,
    authorizations: () => [...authorizations],
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    },
  };
}

describe('Echo Local enterprise PAC stack', () => {
  let upstream: MockHttpServerHandle;
  let stack: EnterpriseProxyStack;

  beforeAll(async () => {
    [upstream, stack] = await Promise.all([
      startMockHttpServer({ host: '::' }),
      startEnterpriseProxyStack(),
    ]);
  });

  afterAll(async () => {
    await Promise.all([upstream.close(), stack.close()]);
  });

  it('serves its PAC from the deterministic enterprise endpoint', async () => {
    const body = await new Promise<string>((resolve, reject) => {
      httpGet(stack.pacUrl, (response) => {
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

  it('completes multi-round Negotiate challenges on one proxy connection', async () => {
    const negotiateProxy = await startMultiRoundNegotiateProxy();
    let token = 0;
    const agent = createOrderedPacProxyAgent(async () => `PROXY 127.0.0.1:${negotiateProxy.port}`, {
      fallbackToDirect: false,
      originalAgent: false,
      lookupProxyAuthorization: async () => `Negotiate client-${(token += 1)}`,
    });

    try {
      await expect(
        request(`http://enterprise-target.localhost:${upstream.port}/json`, agent)
      ).resolves.toBe(200);
      expect(negotiateProxy.connectionCount()).toBe(1);
      expect(negotiateProxy.authorizations()).toEqual([
        'Negotiate client-1',
        'Negotiate client-2',
        'Negotiate client-3',
      ]);
    } finally {
      agent.destroy();
      await negotiateProxy.close();
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
