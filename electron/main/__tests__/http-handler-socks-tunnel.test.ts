// @vitest-environment node
//
// The shared core may call the desktop fetcher more than once per request —
// a Digest challenge/retry, or a followed redirect. Through a SOCKS proxy each
// call needs its OWN tunnel to the hop's target: a single pre-opened tunnel is
// closed after the first response (and points at the first host anyway).
import { randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHandle = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, removeHandler: vi.fn() },
  session: { defaultSession: { resolveProxy: vi.fn() } },
}));
vi.mock('../security/env-proxy', () => ({ resolveEnvProxy: () => undefined }));

import {
  type MockSocksProxyHandle,
  startMockSocksProxyServer,
} from '../../../e2e/mocks/socksProxyServer';
import { IPC } from '../../shared/channels';
import { registerHttpHandlerIPC } from '../handlers/http-handler';
import { setExecutionPolicy } from '../security/execution-policy';

function listen(handler: (url: string, auth: string | undefined, res: ServerResponse) => void) {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => handler(req.url ?? '', req.headers.authorization, res));
  });
  return new Promise<{ server: Server; base: string; port: number }>((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${port}`, port });
    })
  );
}

let socks: MockSocksProxyHandle;
let digest: Awaited<ReturnType<typeof listen>>;
let other: Awaited<ReturnType<typeof listen>>;

beforeAll(async () => {
  socks = await startMockSocksProxyServer();
  other = await listen((_url, _auth, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('other');
  });
  digest = await listen((url, auth, res) => {
    if (url === '/hop') {
      res.writeHead(302, { location: `${other.base}/landed` }).end();
      return;
    }
    if (!auth?.startsWith('Digest ')) {
      res.writeHead(401, { 'www-authenticate': 'Digest realm="r", nonce="n", qop="auth"' });
      res.end('challenge');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' }).end('authed');
  });
});

afterAll(async () => {
  await Promise.all([
    socks.close(),
    ...[digest, other].map((s) => new Promise<void>((r) => s.server.close(() => r()))),
  ]);
});

type IpcHandler = (e: unknown, p: unknown) => Promise<{ status: number; data: unknown }>;

function send(url: string, extra: Record<string, unknown> = {}) {
  const handler = mockHandle.mock.calls.find((c) => c[0] === IPC.http.request)?.[1] as IpcHandler;
  const event = {
    sender: { id: 9200, isDestroyed: () => false, once: vi.fn() },
    senderFrame: { url: 'file:///app/dist/web/index.html', parent: null },
  };
  return handler(event, {
    requestId: randomUUID(),
    method: 'GET',
    url,
    proxy: { enabled: true, type: 'socks5', host: '127.0.0.1', port: socks.port },
    ...extra,
  });
}

describe('desktop SOCKS tunnel per fetcher call', () => {
  beforeEach(() => {
    setExecutionPolicy({
      security: { allowLocalhost: true, allowPrivateIPs: false },
      proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
      timeout: 30_000,
      tls: { verifySsl: true, serverCipherOrder: false },
      certificates: { clientCertificates: [], caCertificates: [] },
    });
    mockHandle.mockClear();
    registerHttpHandlerIPC();
    socks.reset();
  });

  it('answers a 401 Digest challenge through SOCKS with a fresh tunnel for the retry', async () => {
    const res = await send(`${digest.base}/secret`, {
      auth: { type: 'digest', digest: { username: 'u', password: 'p' } },
    });
    expect(res.status).toBe(200);
    expect(res.data).toBe('authed');
    expect(socks.connectHosts()).toEqual([`127.0.0.1:${digest.port}`, `127.0.0.1:${digest.port}`]);
  });

  it('opens the redirect hop tunnel to the hop target, not the original host', async () => {
    const res = await send(`${digest.base}/hop`);
    expect(res.status).toBe(200);
    expect(res.data).toBe('other');
    expect(socks.connectHosts()).toEqual([`127.0.0.1:${digest.port}`, `127.0.0.1:${other.port}`]);
  });

  it('opens no tunnel when request setup fails before dispatch', async () => {
    // An unresolvable client-cert passphrase handle throws while building TLS
    // material; a tunnel opened before that step would leak.
    await expect(
      send(`https://127.0.0.1:${digest.port}/secret`, {
        clientCert: { pfx: 'AA==', passphrase: { kind: 'handle', id: 'missing-handle' } },
      })
    ).rejects.toThrow();
    expect(socks.connectHosts()).toEqual([]);
  });
});
