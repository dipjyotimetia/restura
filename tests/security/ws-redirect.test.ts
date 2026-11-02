// @vitest-environment node
//
// Desktop WebSocket handshake redirects are never followed.
//
// The handler pins DNS through a `lookup` hook, but Node skips `lookup` for
// IP-literal hosts — so a handshake `Location: ws://<ip>:<port>/` would be
// dialed without any policy check if `ws` followed redirects. The handler
// therefore always passes `followRedirects: false`; a 3xx handshake surfaces as
// a clear connection error and the redirect target is never contacted (nor are
// the user's handshake headers replayed to it).
//
// Real `ws` client + loopback servers. Loopback is allowed for the first hop
// (allowLocalhost) so the assertion is "no redirect is followed at all".

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHandle = vi.hoisted(() => vi.fn());
const mockEmitTo = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({ ipcMain: { handle: mockHandle, removeHandler: vi.fn() } }));
vi.mock('../../electron/main/ipc/ipc-utils', () => ({ emitTo: mockEmitTo }));

import {
  registerWebSocketHandlerIPC,
  stopWebSocketCleanup,
} from '../../electron/main/handlers/websocket-handler';
import { setExecutionPolicy } from '../../electron/main/security/execution-policy';
import { IPC } from '../../electron/shared/channels';

type IpcHandler = (e: unknown, p: unknown) => Promise<{ success: boolean; error?: string }>;
const handlerFor = (channel: string) =>
  mockHandle.mock.calls.find((c) => c[0] === channel)?.[1] as IpcHandler;

const listen = (server: Server, host = '127.0.0.1') =>
  new Promise<number>((resolve) =>
    server.listen(0, host, () => resolve((server.address() as AddressInfo).port))
  );
const close = (server: Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });

describe.each([301, 302, 307, 308])('ws:connect handshake HTTP %i', (status) => {
  let origin: Server;
  let target: Server;
  let targetHits: IncomingMessage[];
  let targetPort: number;
  let originPort: number;

  beforeEach(async () => {
    setExecutionPolicy({
      security: { allowLocalhost: true, allowPrivateIPs: false },
      proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
      timeout: 5_000,
      tls: { verifySsl: true, serverCipherOrder: false },
      certificates: { clientCertificates: [], caCertificates: [] },
    });
    mockHandle.mockClear();
    mockEmitTo.mockClear();
    registerWebSocketHandlerIPC();

    targetHits = [];
    target = createServer((req, res) => {
      targetHits.push(req);
      res.end();
    });
    target.on('upgrade', (req, socket) => {
      targetHits.push(req);
      socket.destroy();
    });
    targetPort = await listen(target);

    origin = createServer((_req, res) => res.end());
    origin.on('upgrade', (_req, socket) => {
      // Redirect the handshake to an IP literal (Node skips `lookup` for these).
      socket.end(
        `HTTP/1.1 ${status} Redirect\r\nLocation: ws://127.0.0.1:${targetPort}/internal\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
      );
    });
    // `localhost` may resolve to ::1 first; bind wherever the handler will dial.
    originPort = await listen(origin, 'localhost');
  });

  afterEach(async () => {
    stopWebSocketCleanup();
    await close(origin);
    await close(target);
  });

  it('fails with a clear error and never dials the redirect target', async () => {
    const event = {
      sender: { id: 7000 + status, isDestroyed: () => false, once: vi.fn() },
      senderFrame: { url: 'file:///app/dist/web/index.html', parent: null },
    };
    const connectionId = `redir-${status}`;
    const res = await handlerFor(IPC.ws.connect)(event, {
      connectionId,
      url: `ws://localhost:${originPort}/`,
      headers: { 'X-Api-Key': 'user-secret-header' },
    });
    expect(res.success).toBe(true);

    await vi.waitFor(
      () => {
        const err = mockEmitTo.mock.calls.find((c) => c[1] === `ws:error:${connectionId}`);
        expect(err).toBeDefined();
      },
      { timeout: 4_000 }
    );
    // Give a (buggy) redirect follow time to land before asserting absence.
    await new Promise((r) => setTimeout(r, 200));
    expect(targetHits.map((r) => r.headers['x-api-key'] ?? r.url)).toEqual([]);

    const err = mockEmitTo.mock.calls.find((c) => c[1] === `ws:error:${connectionId}`);
    expect((err?.[2] as { message: string }).message).toBe(
      `Server redirected the WebSocket handshake (HTTP ${status}); redirects aren't followed`
    );
    expect(mockEmitTo.mock.calls.some((c) => c[1] === `ws:open:${connectionId}`)).toBe(false);
  }, 10_000);
});
