// @vitest-environment node
//
// A Content-Encoding on a response that has no content by definition (HEAD,
// 204, 304) — or on an empty 200 — must not run a decompressor: zlib reports
// "unexpected end of file" for zero input and the whole request used to fail.
// Driven through the real http:request IPC handler + undici.
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
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

let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const status = req.url === '/no-content' ? 204 : req.url === '/not-modified' ? 304 : 200;
    // Node omits the body for HEAD/204/304; /empty is a 200 with no bytes.
    res.writeHead(status, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

type IpcResult = { status: number; data: unknown; headers: Record<string, unknown> };

function send(method: string, path: string): Promise<IpcResult> {
  const handler = mockHandle.mock.calls.find((c) => c[0] === IPC.http.request)?.[1] as (
    e: unknown,
    p: unknown
  ) => Promise<IpcResult>;
  const event = {
    sender: { id: 9300, isDestroyed: () => false, once: vi.fn() },
    senderFrame: { url: 'file:///app/dist/web/index.html', parent: null },
  };
  return handler(event, { requestId: randomUUID(), method, url: `${base}${path}` });
}

describe('desktop http:request — Content-Encoding on bodyless responses', () => {
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
  });

  it.each([
    ['HEAD', '/resource', 200],
    ['GET', '/no-content', 204],
    ['GET', '/not-modified', 304],
  ])(
    '%s %s (%i) succeeds with an empty body and keeps the header',
    async (method, path, status) => {
      const res = await send(method, path);
      expect(res.status).toBe(status);
      expect(res.data).toBe('');
      // Nothing was decoded, so the header still describes the representation.
      expect(res.headers['content-encoding']).toBe('gzip');
    }
  );

  it('an empty 200 with a Content-Encoding is an empty body, not a decode error', async () => {
    const res = await send('GET', '/empty');
    expect(res.status).toBe(200);
    expect(res.data).toBe('');
  });
});
