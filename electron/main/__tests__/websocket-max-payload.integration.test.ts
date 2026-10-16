// @vitest-environment node
//
// Pins the decompression-bomb bound with permessage-deflate ON (#923): the
// handler's real `ws` client keeps `maxPayload` = 1 MiB, so a frame that
// inflates past it is refused with close code 1009 (Message Too Big) even
// though it is tiny on the wire. Real `ws` server + client on loopback.
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';

const mockHandle = vi.hoisted(() => vi.fn());
const mockEmitTo = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({ ipcMain: { handle: mockHandle, removeHandler: vi.fn() } }));
vi.mock('../ipc/ipc-utils', () => ({ emitTo: mockEmitTo }));
vi.mock('../security/safe-connect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../security/safe-connect')>();
  return {
    ...actual,
    resolveSafeAddress: vi.fn(async () => ({
      host: 'localhost',
      ip: '127.0.0.1',
      port: 0,
      family: 4 as const,
    })),
  };
});

import { IPC } from '../../shared/channels';
import { registerWebSocketHandlerIPC, stopWebSocketCleanup } from '../handlers/websocket-handler';
import { setExecutionPolicy } from '../security/execution-policy';

type IpcHandler = (e: unknown, p: unknown) => Promise<{ success: boolean; error?: string }>;
const handlerFor = (channel: string) =>
  mockHandle.mock.calls.find((c) => c[0] === channel)?.[1] as IpcHandler;

describe('websocket-handler maxPayload with permessage-deflate', () => {
  let wss: WebSocketServer;

  beforeEach(async () => {
    setExecutionPolicy({
      security: { allowLocalhost: true, allowPrivateIPs: false },
      proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
      timeout: 10_000,
      tls: { verifySsl: true, serverCipherOrder: false },
      certificates: { clientCertificates: [], caCertificates: [] },
    });
    mockHandle.mockClear();
    mockEmitTo.mockClear();
    registerWebSocketHandlerIPC();
    wss = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: true });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  });

  afterEach(async () => {
    stopWebSocketCleanup();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it('closes with 1009 when a compressed frame inflates past 1 MiB', async () => {
    const serverClose = new Promise<number>((resolve) => {
      wss.on('connection', (socket) => {
        socket.on('close', (code) => resolve(code));
        // 2 MiB of zeros compresses to a few KiB on the wire.
        socket.send(Buffer.alloc(2 * 1024 * 1024), { binary: true, compress: true });
      });
    });

    const { port } = wss.address() as AddressInfo;
    const event = {
      sender: { id: 9001, isDestroyed: () => false, once: vi.fn() },
      senderFrame: { url: 'file:///app/dist/web/index.html', parent: null },
    };
    const res = await handlerFor(IPC.ws.connect)(event, {
      connectionId: 'bomb',
      url: `ws://localhost:${port}/`,
    });
    expect(res.success).toBe(true);

    await expect(serverClose).resolves.toBe(1009);
    // The oversized message was never handed to the renderer.
    expect(mockEmitTo.mock.calls.some((c) => c[1] === 'ws:message:bomb')).toBe(false);
  }, 15_000);
});
