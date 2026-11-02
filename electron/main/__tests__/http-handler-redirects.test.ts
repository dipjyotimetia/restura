// @vitest-environment node
//
// Redirects on the desktop http:request path are owned by the shared
// follower (shared/protocol/redirect-follower.ts), which strips credentials on
// cross-origin hops. A second, Electron-level redirect loop used to re-send the
// FULL request config (auth incl. Digest, Authorization, Cookie) for any
// 3xx + Location the shared follower returned (300/304/305/306), bypassing that
// stripping. These tests drive the real IPC handler + undici against two local
// origins and assert nothing credential-bearing reaches the second origin.
import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHandle = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, removeHandler: vi.fn() },
  session: { defaultSession: { resolveProxy: vi.fn() } },
}));
vi.mock('../security/env-proxy', () => ({ resolveEnvProxy: () => undefined }));

import { IPC } from '../../shared/channels';
import { registerHttpHandlerIPC } from '../handlers/http-handler';
import { setExecutionPolicy } from '../security/execution-policy';

type Hit = { url: string; headers: IncomingHttpHeaders };

function startServer(
  handler: (url: string, res: ServerResponse) => void
): Promise<{ server: Server; base: string; hits: Hit[] }> {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    hits.push({ url: req.url ?? '', headers: req.headers });
    req.resume();
    req.on('end', () => handler(req.url ?? '', res));
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        server,
        base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        hits,
      })
    )
  );
}

let a: Awaited<ReturnType<typeof startServer>>;
let b: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  // B: /via-300 answers 300 → B/steal; everything else is a Digest 401.
  b = await startServer((url, res) => {
    if (url === '/plain') {
      res.writeHead(200).end('ok');
      return;
    }
    if (url === '/via-300') {
      res.writeHead(300, { location: `${b.base}/steal` }).end();
      return;
    }
    res.writeHead(401, { 'www-authenticate': 'Digest realm="b", nonce="n1", qop="auth"' });
    res.end('challenge');
  });
  a = await startServer((url, res) => {
    if (url === '/start') {
      res.writeHead(302, { location: '/hop' }).end();
    } else if (url === '/hop') {
      // 300 Multiple Choices is not followed by the shared follower.
      res.writeHead(300, { location: `${b.base}/steal` }).end();
    } else if (url === '/cross-plain') {
      res.writeHead(302, { location: `${b.base}/plain` }).end();
    } else if (url === '/cross') {
      res.writeHead(302, { location: `${b.base}/via-300` }).end();
    } else {
      res.writeHead(404).end();
    }
  });
});

afterAll(async () => {
  await Promise.all(
    [a, b].map((s) => new Promise<void>((resolve) => s.server.close(() => resolve())))
  );
});

type IpcHandler = (e: unknown, p: unknown) => Promise<{ status: number }>;

function send(payload: Record<string, unknown>): Promise<{ status: number }> {
  const handler = mockHandle.mock.calls.find((c) => c[0] === IPC.http.request)?.[1] as IpcHandler;
  const event = {
    sender: { id: 9100, isDestroyed: () => false, once: vi.fn() },
    senderFrame: { url: 'file:///app/dist/web/index.html', parent: null },
  };
  return handler(event, { requestId: randomUUID(), method: 'GET', ...payload });
}

describe('desktop http:request redirect credential handling', () => {
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
    a.hits.length = 0;
    b.hits.length = 0;
  });

  it('removes the same headers as the Worker and CLI on an origin change', async () => {
    await send({
      url: `${a.base}/cross-plain`,
      headers: {
        Authorization: 'Bearer t',
        Cookie: 'a=1',
        'X-Api-Key': 'k',
        'X-Auth-Token': 'k',
        AccessToken: 'k',
        AuthToken: 'k',
        ApiToken: 'k',
        clientSecret: 'k',
        'X-Unusual': 'v',
        Accept: 'application/json',
        'X-Request-Id': 'r',
        'X-Trace': 'abc',
      },
      stripOnOriginChange: ['X-Unusual'],
    });
    const hop = b.hits.find((hit) => hit.url === '/plain');
    expect(hop).toBeDefined();
    for (const name of [
      'authorization',
      'cookie',
      'x-api-key',
      'x-auth-token',
      'accesstoken',
      'authtoken',
      'apitoken',
      'clientsecret',
      'x-unusual',
    ]) {
      expect(hop?.headers[name]).toBeUndefined();
    }
    expect(hop?.headers['accept']).toBe('application/json');
    expect(hop?.headers['x-request-id']).toBe('r');
    expect(hop?.headers['x-trace']).toBe('abc');
  });

  it('302 → 300 cross-origin: Digest is never answered at the other origin', async () => {
    const res = await send({
      url: `${a.base}/start`,
      auth: { type: 'digest', digest: { username: 'u', password: 'p' } },
    });
    expect(res.status).toBe(300);
    expect(b.hits.some((h) => h.headers.authorization !== undefined)).toBe(false);
  });

  it('302 cross-origin then 300: Bearer and Cookie are not re-attached at the other origin', async () => {
    const res = await send({
      url: `${a.base}/cross`,
      headers: { Authorization: 'Bearer secret-token', Cookie: 'session=abc' },
    });
    expect(res.status).toBe(300);
    expect(b.hits.map((h) => h.url)).toEqual(['/via-300']);
    for (const hit of b.hits) {
      expect(hit.headers.authorization).toBeUndefined();
      expect(hit.headers.cookie).toBeUndefined();
    }
  });

  it('302 cross-origin then 300 with Digest: no Authorization reaches the other origin', async () => {
    const res = await send({
      url: `${a.base}/cross`,
      auth: { type: 'digest', digest: { username: 'u', password: 'p' } },
    });
    expect(res.status).toBe(300);
    expect(b.hits.some((h) => h.headers.authorization !== undefined)).toBe(false);
  });
});
