// @vitest-environment node
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', isPackaged: false },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
}));

import { createClientCredentialsTokenProvider } from '../handlers/kafka/sasl-oauth';
import { setExecutionPolicy } from '../security/execution-policy';

/**
 * Exercises the REAL guarded token fetch (string policy → DNS-pinned undici
 * fetch with the execution policy's TLS settings) against a loopback IdP —
 * no fetch mocks. Loopback is permitted by the default desktop policy.
 */
const requests: Array<{ method?: string; url?: string; body: string }> = [];
let server: Server;
let base: string;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
  });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({ method: req.method, url: req.url, body });
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ access_token: `tok-${requests.length}`, expires_in: 120 }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  requests.length = 0;
  setExecutionPolicy({
    security: { allowLocalhost: true, allowPrivateIPs: false },
    proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
    timeout: 30_000,
    tls: { verifySsl: true, serverCipherOrder: false },
    certificates: { clientCertificates: [], caCertificates: [] },
  });
});

describe('client-credentials token fetch over the real guarded transport', () => {
  it('posts the grant to a loopback IdP and caches until exp - 30s', async () => {
    let now = 0;
    const provider = createClientCredentialsTokenProvider(
      { tokenEndpoint: `${base}/token`, clientId: 'cid', clientSecret: 'sec', scope: 'kafka' },
      { resolveSecret: async (v) => (typeof v === 'string' ? v : undefined), now: () => now }
    );
    expect(await provider()).toBe('tok-1');
    expect(requests[0]).toMatchObject({ method: 'POST', url: '/token' });
    const form = new URLSearchParams(requests[0]!.body);
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.get('client_secret')).toBe('sec');

    now = 89_999;
    expect(await provider()).toBe('tok-1');
    now = 90_000;
    expect(await provider()).toBe('tok-2');
    expect(requests).toHaveLength(2);
  });

  it('does not follow a redirect from the token endpoint', async () => {
    const provider = createClientCredentialsTokenProvider(
      { tokenEndpoint: `${base}/redirect`, clientId: 'cid', clientSecret: 'sec' },
      { resolveSecret: async () => 'sec' }
    );
    await expect(provider()).rejects.toThrow();
    expect(requests.map((r) => r.url)).toEqual(['/redirect']);
  });

  it('rejects loopback when the policy disallows localhost', async () => {
    setExecutionPolicy({
      security: { allowLocalhost: false, allowPrivateIPs: false },
      proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
      timeout: 30_000,
      tls: { verifySsl: true, serverCipherOrder: false },
      certificates: { clientCertificates: [], caCertificates: [] },
    });
    const provider = createClientCredentialsTokenProvider(
      { tokenEndpoint: `${base}/token`, clientId: 'cid', clientSecret: 'sec' },
      { resolveSecret: async () => 'sec' }
    );
    await expect(provider()).rejects.toThrow(/token endpoint rejected/i);
    expect(requests).toHaveLength(0);
  });
});
