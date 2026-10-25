// @vitest-environment node
//
// Desktop HTTP auth fields referencing SecretRef-backed `{{vars}}` (ADR-0007).
//
// The renderer leaves `{{secretVar}}` tokens opaque inside `spec.auth`; Electron
// main substitutes them at wire time (secret-variable-materializer) and, for
// Basic, builds the Authorization header itself. The upstream must receive the
// resolved credential, and the plaintext must never travel back to the
// renderer — not in the `http:request` reply, not in a thrown error, and not
// in the request-log entry or main-process log lines.
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'S3cr3t-Pl@in text&1';

const mockHandle = vi.hoisted(() => vi.fn());
const mockLog = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, removeHandler: vi.fn() },
  session: { defaultSession: { resolveProxy: vi.fn() } },
}));
vi.mock('../../electron/main/security/env-proxy', () => ({ resolveEnvProxy: () => undefined }));
vi.mock('@shared/runtime/logger', () => ({ createLogger: () => mockLog }));
vi.mock('../../electron/main/security/secret-handle-store', () => ({
  unwrapSecretValueMain: (v: unknown): string | undefined => {
    if (typeof v === 'string') return v;
    const ref = v as { kind?: string; value?: string; id?: string } | undefined;
    if (ref?.kind === 'inline') return ref.value;
    if (ref?.kind === 'handle') return ref.id === 'h-secret' ? SECRET : undefined;
    return undefined;
  },
}));

import { registerHttpHandlerIPC } from '../../electron/main/handlers/http-handler';
import type { LogEntry } from '../../electron/main/lifecycle/request-logger';
import { setExecutionPolicy } from '../../electron/main/security/execution-policy';
import { IPC } from '../../electron/shared/channels';

type IpcHandler = (e: unknown, p: unknown) => Promise<unknown>;

const received: Array<Record<string, string | string[] | undefined>> = [];
const logEntries: LogEntry[] = [];
let server: http.Server;
let handler: IpcHandler;
let baseUrl: string;
let requestCounter = 0;

const event = {
  sender: { id: 4243, isDestroyed: () => false, once: vi.fn() },
  senderFrame: { url: 'file:///app/dist/web/index.html', parent: null },
};
const secretVariables = { pw: { kind: 'handle', id: 'h-secret' } };

function nextRequestId(): string {
  requestCounter += 1;
  return `33333333-3333-4333-8333-${String(requestCounter).padStart(12, '0')}`;
}

function assertNoPlaintext(value: unknown): void {
  const text = JSON.stringify(value) ?? '';
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(Buffer.from(`alice:${SECRET}`).toString('base64'));
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    received.push({ ...req.headers });
    const basicOk =
      req.headers.authorization === `Basic ${Buffer.from(`alice:${SECRET}`).toString('base64')}`;
    const wsseOk = String(req.headers['x-wsse'] ?? '').includes(`PasswordText="${SECRET}"`);
    res.statusCode = basicOk || wsseOk ? 200 : 401;
    res.setHeader('Content-Type', 'text/plain');
    res.end(res.statusCode === 200 ? 'ok' : 'denied');
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
  registerHttpHandlerIPC((entry) => logEntries.push(entry));
  handler = mockHandle.mock.calls.find((c) => c[0] === IPC.http.request)?.[1] as IpcHandler;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  received.length = 0;
  logEntries.length = 0;
});

function allLogCalls(): unknown[] {
  return Object.values(mockLog).flatMap((fn) => fn.mock.calls);
}

describe('http:request — secret variables in auth fields', () => {
  it('builds Basic main-side from a deferred {{secretVar}} without echoing it', async () => {
    const reply = await handler(event, {
      requestId: nextRequestId(),
      method: 'GET',
      url: `${baseUrl}/basic`,
      auth: { type: 'basic', basic: { username: 'alice', password: '{{pw}}' } },
      secretVariables,
    });
    expect((reply as { status: number }).status).toBe(200);
    assertNoPlaintext(reply);
    assertNoPlaintext(logEntries);
    assertNoPlaintext(allLogCalls());
  });

  it('substitutes {{secretVar}} in a sign-at-wire (WSSE) descriptor before signing', async () => {
    const reply = await handler(event, {
      requestId: nextRequestId(),
      method: 'GET',
      url: `${baseUrl}/wsse`,
      auth: {
        type: 'wsse',
        wsse: { username: 'alice', password: '{{pw}}', passwordType: 'PasswordText' },
      },
      secretVariables,
    });
    expect((reply as { status: number }).status).toBe(200);
    expect(String(received[0]?.['x-wsse'])).not.toContain('{{pw}}');
    assertNoPlaintext(reply);
    assertNoPlaintext(logEntries);
  });

  it('keeps the plaintext out of transport errors and the request log', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    let thrown: unknown;
    try {
      await handler(event, {
        requestId: nextRequestId(),
        method: 'GET',
        url: `http://127.0.0.1:${port}/down`,
        auth: { type: 'basic', basic: { username: 'alice', password: '{{pw}}' } },
        secretVariables,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain(SECRET);
    assertNoPlaintext(logEntries);
    assertNoPlaintext(allLogCalls());
  });
});
