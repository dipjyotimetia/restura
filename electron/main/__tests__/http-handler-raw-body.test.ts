// @vitest-environment node
//
// Desktop/web parity for the buffered http:request reply: the body travels as
// the exact text the upstream sent (the Worker's `data` is the raw string),
// never JSON-parsed in main — a parse + re-stringify in the renderer loses
// big-int precision, unwraps `"quoted"` and turns `null` into "". And the
// status text is filled from the standard reason phrase, since undici's
// `request` API does not expose the one on the wire (web's fetch does), so
// `pm.response.to.have.status('OK')` passes on both.
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mockHandle = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, removeHandler: vi.fn() },
  session: { defaultSession: { resolveProxy: vi.fn() } },
}));
vi.mock('../security/env-proxy', () => ({ resolveEnvProxy: () => undefined }));

import { IPC } from '../../shared/channels';
import { registerHttpHandlerIPC } from '../handlers/http-handler';
import { setExecutionPolicy } from '../security/execution-policy';

const BODIES: Record<string, { status: number; body: string; type: string }> = {
  '/bigint': { status: 200, body: '{"id":12345678901234567890,"x":1.0}', type: 'application/json' },
  '/quoted': { status: 200, body: '"quoted"', type: 'application/json' },
  '/null': { status: 200, body: 'null', type: 'application/json' },
  '/teapot': { status: 418, body: '', type: 'text/plain' },
  '/custom': { status: 299, body: 'x', type: 'text/plain' },
};

type Reply = { status: number; statusText: string; data: unknown };
type IpcHandler = (e: unknown, p: unknown) => Promise<Reply>;

let server: http.Server;
let handler: IpcHandler;
let baseUrl: string;
let counter = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const spec = BODIES[req.url ?? ''] ?? { status: 404, body: '', type: 'text/plain' };
    res.writeHead(spec.status, { 'Content-Type': spec.type });
    res.end(spec.body);
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
  handler = mockHandle.mock.calls.find((c) => c[0] === IPC.http.request)?.[1] as IpcHandler;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function send(path: string): Promise<Reply> {
  counter += 1;
  const event = {
    sender: { id: 4243, isDestroyed: () => false, once: vi.fn() },
    senderFrame: { url: 'file:///app/dist/web/index.html', parent: null },
  };
  return handler(event, {
    requestId: `33333333-3333-4333-8333-${String(counter).padStart(12, '0')}`,
    method: 'GET',
    url: `${baseUrl}${path}`,
  });
}

describe('http:request IPC — raw body + status text (web parity)', () => {
  it.each(['/bigint', '/quoted', '/null'])('returns %s as the exact upstream text', async (p) => {
    const reply = await send(p);
    expect(reply.status).toBe(200);
    expect(reply.data).toBe(BODIES[p]!.body);
  });

  it('fills statusText from the standard reason phrase', async () => {
    expect((await send('/bigint')).statusText).toBe('OK');
    expect((await send('/teapot')).statusText).toBe("I'm a Teapot");
  });

  it('leaves statusText empty for a code with no standard phrase', async () => {
    expect((await send('/custom')).statusText).toBe('');
  });
});
