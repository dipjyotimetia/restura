// @vitest-environment node
//
// An HTTP proxy password stored as a keychain handle that is gone on this
// device must fail the request, not reach the proxy without credentials.
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHandle = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, removeHandler: vi.fn() },
  session: { defaultSession: { resolveProxy: vi.fn() } },
}));
vi.mock('../security/env-proxy', () => ({ resolveEnvProxy: () => undefined }));
vi.mock('../security/secret-handle-store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  // A handle with no record on this device resolves to nothing.
  unwrapSecretValueMain: (v: unknown): string | undefined => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object' && (v as { kind?: string }).kind === 'inline') {
      return (v as { value?: string }).value;
    }
    return undefined;
  },
}));

import { IPC } from '../../shared/channels';
import { registerHttpHandlerIPC } from '../handlers/http-handler';
import { setExecutionPolicy } from '../security/execution-policy';

let proxy: Server;
let proxyPort: number;
let connections = 0;

beforeAll(async () => {
  proxy = createServer((socket) => {
    connections += 1;
    socket.end('HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n');
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  proxyPort = (proxy.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((resolve) => proxy.close(() => resolve())));

type IpcHandler = (e: unknown, p: unknown) => Promise<{ status: number; data: unknown }>;

describe('desktop HTTP proxy password', () => {
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
    connections = 0;
  });

  it('fails instead of sending through the proxy without a password whose handle is gone', async () => {
    const handler = mockHandle.mock.calls.find((c) => c[0] === IPC.http.request)?.[1] as IpcHandler;
    const event = {
      sender: { id: 9201, isDestroyed: () => false, once: vi.fn() },
      senderFrame: { url: 'file:///app/dist/web/index.html', parent: null },
    };
    await expect(
      handler(event, {
        requestId: randomUUID(),
        method: 'GET',
        url: 'http://127.0.0.1:9/x',
        proxy: {
          enabled: true,
          type: 'http',
          host: '127.0.0.1',
          port: proxyPort,
          auth: {
            username: 'u',
            password: { kind: 'handle', id: '00000000-0000-4000-8000-000000000000' },
          },
        },
      })
    ).rejects.toThrow(/Proxy password is unavailable on this device/);
    expect(connections).toBe(0);
  });
});
