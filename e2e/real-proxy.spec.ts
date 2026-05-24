import { test, expect } from './fixtures/servers';
import { setUrl, sendButton } from './utils/selectors';
import { configureProxy } from './utils/configureProxy';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import * as tls from 'node:tls';

/**
 * Web mode: axios in the browser ignores native proxy config (browser sandbox
 * forbids raw socket proxying). End-to-end verification of an HTTP proxy
 * therefore happens in two layers:
 *
 *   1. UI layer — configuring proxy via Settings → Proxy persists correctly,
 *      surfaces the URL preview, and doesn't break the page.
 *
 *   2. Wire layer — we directly drive the mock proxy with Node's http client
 *      to prove the proxy actually CONNECT-tunnels and forwards traffic.
 *      That isolates the proxy server from the browser's restrictions.
 *
 * Full browser-driven proxy traversal is exercised by the Electron e2e suite
 * (separate from this web-only suite) where the desktop runtime can open raw
 * sockets.
 */
test.describe('Real HTTP proxy', () => {
  test('Settings UI configures proxy and surfaces the URL preview', async ({
    app: page,
    servers,
  }) => {
    await configureProxy(page, '127.0.0.1', servers.proxy.port);

    // Reopen settings → Proxy and confirm host/port persisted.
    await page.getByRole('button', { name: 'Open settings' }).click();
    await page.getByRole('button', { name: /^Proxy$/ }).click();

    await expect(page.getByPlaceholder('proxy.example.com')).toHaveValue('127.0.0.1');
    await expect(
      page.getByRole('dialog', { name: 'Settings' }).locator('input[type="number"]').first()
    ).toHaveValue(String(servers.proxy.port));

    await page.keyboard.press('Escape');
  });

  test('UI request still completes after proxy is configured (browser ignores proxy)', async ({
    app: page,
    servers,
  }) => {
    await configureProxy(page, '127.0.0.1', servers.proxy.port);

    await setUrl(page, `${servers.http.url}/json`);
    await sendButton(page).click();

    // Browser axios ignores proxy config; the request still succeeds direct.
    await expect(page.getByText('200', { exact: true }).first()).toBeVisible();
    expect(servers.http.requestCount()).toBe(1);
  });

  test('CONNECT tunnel — Node client through mock proxy reaches HTTPS upstream', async ({
    servers,
  }) => {
    // Drive the proxy directly with a Node HTTP client. This proves the proxy
    // server itself works end-to-end (CONNECT, tunneling, byte forwarding)
    // without needing a browser that supports raw socket proxies.
    const upstreamHostPort = `127.0.0.1:${servers.https.port}`;

    await new Promise<void>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: servers.proxy.port,
        method: 'CONNECT',
        path: upstreamHostPort,
      });

      req.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          reject(new Error(`CONNECT failed: ${res.statusCode}`));
          return;
        }

        const tlsSocket = tls.connect({
          socket,
          host: '127.0.0.1',
          servername: 'localhost',
          rejectUnauthorized: false,
        });
        tlsSocket.on('secureConnect', () => {
          tlsSocket.write('GET /json HTTP/1.1\r\nhost: 127.0.0.1\r\nconnection: close\r\n\r\n');
        });
        const chunks: Buffer[] = [];
        tlsSocket.on('data', (c: Buffer) => chunks.push(c));
        tlsSocket.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (!text.includes('"hello"')) {
            reject(new Error(`unexpected response: ${text.slice(0, 200)}`));
          } else {
            resolve();
          }
        });
        tlsSocket.on('error', reject);
      });

      req.on('error', reject);
      req.end();
    });

    expect(servers.proxy.connectCount()).toBe(1);
    expect(servers.proxy.connectHosts()).toContain(upstreamHostPort);
    expect(servers.https.requestCount()).toBe(1);
    expect(servers.https.requests()[0]?.path).toBe('/json');
  });

  test('Plain HTTP forward — Node client through mock proxy reaches HTTP upstream', async ({
    servers,
  }) => {
    const targetUrl = `${servers.http.url}/json`;

    const body = await new Promise<string>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: servers.proxy.port,
          method: 'GET',
          // Absolute URI in request line is the canonical "ask the proxy" form.
          path: targetUrl,
          headers: { host: `127.0.0.1:${servers.http.port}` },
        },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          res.on('error', reject);
        }
      );
      req.on('error', reject);
      req.end();
    });

    expect(body).toContain('"hello"');
    expect(servers.proxy.forwardCount()).toBeGreaterThanOrEqual(1);
    // Upstream must have seen the forwarded request (with our proxy marker).
    const upstream = servers.http.requests().find((r) => r.path === '/json');
    expect(upstream).toBeDefined();
    expect(upstream?.headers['x-forwarded-by']).toBe('mock-proxy');
  });
});
