import { test, expect } from './fixtures/servers';
import { request as httpRequest } from 'node:http';

/**
 * Proxy authentication scenarios. The proxy can be put into auth mode via
 * `setBasicAuth(user, pass)`. Without `Proxy-Authorization`, the proxy
 * answers 407 with `Proxy-Authenticate`. With matching credentials, it
 * forwards normally.
 */
async function forwardThroughProxy(
  proxyHost: string,
  proxyPort: number,
  targetUrl: string,
  headers: Record<string, string> = {}
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: proxyHost,
        port: proxyPort,
        method: 'GET',
        path: targetUrl,
        headers: { host: new URL(targetUrl).host, ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

test.describe('HTTP proxy — Basic auth', () => {
  test('without credentials, the proxy returns 407 with Proxy-Authenticate', async ({
    servers,
  }) => {
    servers.proxy.setBasicAuth('alice', 'secret');
    const res = await forwardThroughProxy(
      '127.0.0.1',
      servers.proxy.port,
      `${servers.http.url}/json`
    );
    expect(res.status).toBe(407);
    expect(res.headers['proxy-authenticate']).toContain('Basic');
    expect(servers.proxy.authChallengeCount()).toBe(1);
    servers.proxy.clearBasicAuth();
  });

  test('with correct Proxy-Authorization, the proxy forwards', async ({ servers }) => {
    servers.proxy.setBasicAuth('alice', 'secret');
    const credentials = Buffer.from('alice:secret').toString('base64');
    const res = await forwardThroughProxy(
      '127.0.0.1',
      servers.proxy.port,
      `${servers.http.url}/json`,
      { 'proxy-authorization': `Basic ${credentials}` }
    );
    expect(res.status).toBe(200);
    expect(res.body).toContain('"hello"');
    expect(servers.proxy.forwardCount()).toBeGreaterThanOrEqual(1);
    servers.proxy.clearBasicAuth();
  });

  test('with wrong Proxy-Authorization, the proxy still 407s', async ({ servers }) => {
    servers.proxy.setBasicAuth('alice', 'secret');
    const credentials = Buffer.from('alice:wrong-pass').toString('base64');
    const res = await forwardThroughProxy(
      '127.0.0.1',
      servers.proxy.port,
      `${servers.http.url}/json`,
      { 'proxy-authorization': `Basic ${credentials}` }
    );
    expect(res.status).toBe(407);
    servers.proxy.clearBasicAuth();
  });

  test('CONNECT tunnel rejects without auth and accepts with auth', async ({ servers }) => {
    servers.proxy.setBasicAuth('alice', 'secret');

    const noAuth = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: servers.proxy.port,
        method: 'CONNECT',
        path: '127.0.0.1:443',
      });
      req.on('connect', (res) => resolve(res.statusCode ?? 0));
      req.on('error', reject);
      req.end();
    });
    expect(noAuth).toBe(407);

    const credentials = Buffer.from('alice:secret').toString('base64');
    const withAuth = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: servers.proxy.port,
        method: 'CONNECT',
        path: `127.0.0.1:${servers.https.port}`,
        headers: { 'proxy-authorization': `Basic ${credentials}` },
      });
      req.on('connect', (res, socket) => {
        socket.destroy();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(withAuth).toBe(200);
    servers.proxy.clearBasicAuth();
  });
});
