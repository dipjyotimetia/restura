// @vitest-environment node
//
// #855: every Set-Cookie field must survive the desktop http:request IPC
// round-trip (real undici fetcher → shared core → IPC HttpResponse), not just
// the shared core. Uses a local upstream that sends three separate fields.
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mockHandle = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, removeHandler: vi.fn() },
  session: { defaultSession: { resolveProxy: vi.fn() } },
}));
// Pin the fetcher to the direct path regardless of the host's HTTP(S)_PROXY.
vi.mock('../security/env-proxy', () => ({ resolveEnvProxy: () => undefined }));

import { IPC } from '../../shared/channels';
import { registerHttpHandlerIPC } from '../handlers/http-handler';
import { setExecutionPolicy } from '../security/execution-policy';

const COOKIES = [
  'session=abc123; Path=/; HttpOnly',
  'csrf=tok-1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/',
  'pref=dark; Max-Age=3600',
];

type IpcHandler = (e: unknown, p: unknown) => Promise<{ status: number; setCookies?: string[] }>;

let server: http.Server;
let handler: IpcHandler;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Set-Cookie', COOKIES);
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setExecutionPolicy({
    security: { allowLocalhost: true, allowPrivateIPs: false },
    proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
    timeout: 30_000,
    tls: { verifySsl: true, serverCipherOrder: false },
    certificates: { clientCertificates: [], caCertificates: [] },
  });
  registerHttpHandlerIPC();
  // Capture now — the test runner resets mock call history between tests.
  handler = mockHandle.mock.calls.find((c) => c[0] === IPC.http.request)?.[1] as IpcHandler;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('http:request IPC — multiple Set-Cookie (#855)', () => {
  it('returns each Set-Cookie field as its own setCookies entry', async () => {
    const event = {
      sender: { id: 4242, isDestroyed: () => false, once: vi.fn() },
      senderFrame: { url: 'file:///app/dist/web/index.html', parent: null },
    };
    const result = await handler(event, {
      requestId: '22222222-2222-4222-8222-222222222222',
      method: 'GET',
      url: `${baseUrl}/cookies`,
    });
    expect(result.status).toBe(200);
    expect(result.setCookies).toEqual(COOKIES);
  });
});
