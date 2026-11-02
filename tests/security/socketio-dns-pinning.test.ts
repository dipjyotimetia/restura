// @vitest-environment node
//
// Socket.IO connect-time SSRF / DNS-rebind pinning regression.
//
// The Socket.IO Electron handler used to SSRF-validate the URL with a one-shot
// `assertUrlHostnameSafe` pre-flight, then hand the raw URL to socket.io-client
// — which re-resolves DNS at connect time (and on every reconnect), leaving a
// TTL=0 rebind / TOCTOU window the WS and gRPC handlers had already closed.
//
// It now resolves+validates once via `resolveSafeAddress` and pins every
// transport (ws + xhr polling) to that IP through an http(s).Agent carrying a
// pinned `lookup`. These tests assert:
//   1. a connect-time SSRF rejection aborts BEFORE any socket is created;
//   2. on success the agent is wired with the pinned lookup, and the agent
//      family (http vs https) follows the URL scheme;
//   3. a long-polling response redirect (server refuses the WS upgrade, then
//      answers polling with a 3xx) is never followed: the redirect target is
//      never contacted and the user's extraHeaders never reach it.

import { createServer, Agent as HttpAgent, type IncomingMessage, type Server } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHandle = vi.hoisted(() => vi.fn());
const mockResolveSafe = vi.hoisted(() => vi.fn());
const mockCreatePinnedLookup = vi.hoisted(() =>
  vi.fn(
    (_host: string, _ip: string): unknown =>
      () =>
        undefined
  )
);
const mockIo = vi.hoisted(() => vi.fn());
const mockEmitTo = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, removeHandler: vi.fn() },
}));
vi.mock('../../electron/main/security/safe-connect', () => ({
  resolveSafeAddress: mockResolveSafe,
  createPinnedLookup: mockCreatePinnedLookup,
}));
vi.mock('socket.io-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('socket.io-client')>()),
  io: mockIo,
}));
vi.mock('../../electron/main/ipc/ipc-utils', () => ({ emitTo: mockEmitTo }));
vi.mock('../../electron/main/ipc/connection-cleanup', () => ({
  bindRendererCleanup: vi.fn(),
  disposeByOwner: vi.fn(),
}));
vi.mock('../../electron/main/ipc/ipc-rate-limiter', () => ({
  createKeyedRateLimiter: () => ({ check: () => true }),
}));
vi.mock('../../electron/main/ipc/ipc-validators', () => ({
  // Pass the payload straight through — schema validation isn't under test here.
  validateIpcInput: (_schema: unknown, raw: unknown) => raw,
  assertTrustedSender: () => {},
  createValidatedHandler:
    (_ch: unknown, _schema: unknown, fn: (c: unknown) => unknown) => (_e: unknown, c: unknown) =>
      fn(c),
  createValidatedEventHandler:
    (_ch: unknown, _schema: unknown, fn: (c: unknown, e: unknown) => unknown) =>
    (e: unknown, c: unknown) =>
      fn(c, e),
  SocketIoConnectSchema: {},
  SocketIoEmitSchema: {},
  SocketIoReplyAckSchema: {},
  SocketIoDisconnectSchema: {},
}));

import { registerSocketIoHandlerIPC } from '../../electron/main/handlers/socketio-handler';
import { setExecutionPolicy } from '../../electron/main/security/execution-policy';
import { IPC } from '../../electron/shared/channels';

function makeFakeSocket() {
  return {
    on: vi.fn(),
    onAny: vi.fn(),
    io: { on: vi.fn() },
    connected: false,
    disconnect: vi.fn(),
  };
}

function getConnectHandler(): (
  e: unknown,
  c: unknown
) => Promise<{ success: boolean; error?: string }> {
  const call = mockHandle.mock.calls.find((c) => c[0] === IPC.socketio.connect);
  return call?.[1] as (e: unknown, c: unknown) => Promise<{ success: boolean; error?: string }>;
}

const fakeEvent = { sender: { id: 1, isDestroyed: () => false } };

describe('socketio-handler DNS pinning', () => {
  beforeEach(() => {
    setExecutionPolicy({
      security: { allowLocalhost: true, allowPrivateIPs: false },
      proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
      timeout: 30_000,
      tls: { verifySsl: true, serverCipherOrder: false },
      certificates: { clientCertificates: [], caCertificates: [] },
    });
    mockHandle.mockClear();
    mockResolveSafe.mockReset();
    mockCreatePinnedLookup.mockClear();
    mockIo.mockReset();
    mockIo.mockImplementation(() => makeFakeSocket());
    registerSocketIoHandlerIPC();
  });

  it('rejects at connect time and never creates a socket when SSRF policy denies the host', async () => {
    mockResolveSafe.mockRejectedValue(new Error('Address 169.254.169.254 blocked by SSRF policy'));
    const handler = getConnectHandler();

    const result = await handler(fakeEvent, {
      connectionId: 'c1',
      url: 'http://metadata.evil.test',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/SSRF/i);
    // The rebind window is closed only if no socket is opened after a denied resolve.
    expect(mockIo).not.toHaveBeenCalled();
  });

  it('pins the connection to the validated IP via a lookup-bearing agent (wss → https agent)', async () => {
    mockResolveSafe.mockResolvedValue({
      host: 'api.example.com',
      ip: '93.184.216.34',
      port: 443,
      family: 4,
    });
    const handler = getConnectHandler();

    const result = await handler(fakeEvent, {
      connectionId: 'c2',
      url: 'wss://api.example.com',
    });

    expect(result.success).toBe(true);
    expect(mockCreatePinnedLookup).toHaveBeenCalledWith('api.example.com', '93.184.216.34');
    expect(mockIo).toHaveBeenCalledTimes(1);

    const opts = mockIo.mock.calls[0]![1] as { agent: unknown };
    expect(opts.agent).toBeInstanceOf(HttpsAgent);
  });

  it('uses a plain http agent for an insecure ws:// target', async () => {
    mockResolveSafe.mockResolvedValue({
      host: 'api.example.com',
      ip: '93.184.216.34',
      port: 80,
      family: 4,
    });
    const handler = getConnectHandler();

    await handler(fakeEvent, { connectionId: 'c3', url: 'ws://api.example.com' });

    const opts = mockIo.mock.calls[0]![1] as { agent: unknown };
    expect(opts.agent).toBeInstanceOf(HttpAgent);
    // https.Agent extends http.Agent, so explicitly assert it is NOT the TLS variant.
    expect(opts.agent).not.toBeInstanceOf(HttpsAgent);
  });
});

// --- Real socket.io-client + real safe-connect against loopback servers. ---
// Loopback is allowed for the first hop (allowLocalhost), so "the redirect target
// is never contacted" means "no redirect is followed at all".

const listen = (server: Server, host = '127.0.0.1') =>
  new Promise<number>((resolve) =>
    server.listen(0, host, () => resolve((server.address() as AddressInfo).port))
  );
const close = (server: Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });

async function useRealClient(): Promise<void> {
  const actualIo = (await vi.importActual<typeof import('socket.io-client')>('socket.io-client'))
    .io;
  const actualSafe = await vi.importActual<
    typeof import('../../electron/main/security/safe-connect')
  >('../../electron/main/security/safe-connect');
  setExecutionPolicy({
    security: { allowLocalhost: true, allowPrivateIPs: false },
    proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
    timeout: 5_000,
    tls: { verifySsl: true, serverCipherOrder: false },
    certificates: { clientCertificates: [], caCertificates: [] },
  });
  mockHandle.mockClear();
  mockEmitTo.mockClear();
  mockIo.mockReset();
  mockIo.mockImplementation(actualIo);
  mockResolveSafe.mockReset();
  mockResolveSafe.mockImplementation(actualSafe.resolveSafeAddress);
  mockCreatePinnedLookup.mockReset();
  mockCreatePinnedLookup.mockImplementation(actualSafe.createPinnedLookup);
  registerSocketIoHandlerIPC();
}

function disconnectRealClients(): void {
  for (const r of mockIo.mock.results) (r.value as { disconnect?: () => void })?.disconnect?.();
}

const emitted = (channel: string) => mockEmitTo.mock.calls.filter((c) => c[1] === channel);

describe('socketio-handler long-polling redirects', () => {
  let targetPort: number;
  let origin: Server;
  let target: Server;
  let originPort: number;
  let targetHits: IncomingMessage[];
  let originPolls: number;

  beforeEach(async () => {
    await useRealClient();

    targetHits = [];
    target = createServer((req, res) => {
      targetHits.push(req);
      res.end('0{"sid":"x","upgrades":[],"pingInterval":25000,"pingTimeout":20000}');
    });
    target.on('upgrade', (req, socket) => {
      targetHits.push(req);
      socket.destroy();
    });
    targetPort = await listen(target);

    originPolls = 0;
    origin = createServer((_req, res) => {
      // Long-polling request: bounce it to an IP literal on another port
      // (Node skips the pinned `lookup` for IP literals).
      originPolls++;
      res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/internal` });
      res.end();
    });
    // Refuse any WebSocket upgrade.
    origin.on('upgrade', (_req, socket) => {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    });
    // `localhost` may resolve to ::1 first; bind wherever the handler will dial.
    originPort = await listen(origin, 'localhost');
  });

  afterEach(async () => {
    disconnectRealClients();
    await close(origin);
    await close(target);
  });

  it.each([[['polling']], [['polling', 'websocket']]])(
    'transports %j: never follows the 3xx and never sends extraHeaders elsewhere',
    async (transports) => {
      const connectionId = `redir-${transports.join('-')}`;
      const result = await getConnectHandler()(fakeEvent, {
        connectionId,
        url: `http://localhost:${originPort}`,
        extraHeaders: { 'X-Api-Key': 'user-secret-header' },
        reconnection: false,
        transports,
      });
      expect(result.success).toBe(true);

      await vi.waitFor(() => expect(originPolls).toBeGreaterThan(0), { timeout: 4_000 });
      // Give a (buggy) redirect follow time to land before asserting absence.
      await new Promise((r) => setTimeout(r, 300));
      expect(targetHits.map((r) => r.headers['x-api-key'] ?? r.url)).toEqual([]);

      await vi.waitFor(
        () => expect(emitted(`socketio:error:${connectionId}`).length).toBeGreaterThan(0),
        { timeout: 4_000 }
      );
      expect(emitted(`socketio:error:${connectionId}`)[0]?.[2]).toEqual({
        message:
          "Server redirected the Socket.IO polling request (HTTP 302); redirects aren't followed",
      });
      expect(emitted(`socketio:open:${connectionId}`)).toHaveLength(0);
    },
    10_000
  );

  it('transports ["websocket"]: names a redirected handshake and sends nothing elsewhere', async () => {
    const connectionId = 'redir-ws-first';
    origin.removeAllListeners('upgrade');
    origin.on('upgrade', (_req, socket) => {
      socket.end(`HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:${targetPort}/\r\n\r\n`);
    });
    const result = await getConnectHandler()(fakeEvent, {
      connectionId,
      url: `http://localhost:${originPort}`,
      extraHeaders: { 'X-Api-Key': 'user-secret-header' },
      reconnection: false,
      transports: ['websocket'],
    });
    expect(result.success).toBe(true);
    await vi.waitFor(
      () => expect(emitted(`socketio:error:${connectionId}`).length).toBeGreaterThan(0),
      { timeout: 4_000 }
    );
    expect(emitted(`socketio:error:${connectionId}`)[0]?.[2]).toEqual({
      message: "Server redirected the Socket.IO handshake (HTTP 302); redirects aren't followed",
    });
    expect(targetHits).toEqual([]);
  }, 10_000);
});

describe('socketio-handler redirect-free polling still connects normally', () => {
  let httpServer: Server;
  let port: number;
  let seenHeaders: Array<string | undefined>;
  let ioServer: import('socket.io').Server;

  beforeEach(async () => {
    await useRealClient();
    const { Server: IoServer } = await import('socket.io');
    seenHeaders = [];
    httpServer = createServer();
    ioServer = new IoServer(httpServer);
    // After attach: engine.io re-registers the 'request' listeners on attach.
    httpServer.prependListener('request', (req) => {
      seenHeaders.push(req.headers['x-api-key'] as string | undefined);
    });
    ioServer.on('connection', (socket) => {
      socket.on('echo', (msg: string) => socket.emit('echoed', msg));
    });
    port = await listen(httpServer, 'localhost');
  });

  afterEach(async () => {
    disconnectRealClients();
    await new Promise<void>((resolve) => ioServer.close(() => resolve()));
  });

  it.each([[['polling']], [['polling', 'websocket']], [['websocket', 'polling']]])(
    'transports %j: opens, carries extraHeaders and round-trips an event',
    async (transports) => {
      const connectionId = `ok-${transports.join('-')}`;
      const result = await getConnectHandler()(fakeEvent, {
        connectionId,
        url: `http://localhost:${port}`,
        extraHeaders: { 'X-Api-Key': 'user-secret-header' },
        reconnection: false,
        transports,
      });
      expect(result.success).toBe(true);
      await vi.waitFor(
        () => expect(emitted(`socketio:open:${connectionId}`).length).toBeGreaterThan(0),
        { timeout: 4_000 }
      );

      const socket = mockIo.mock.results.at(-1)?.value as {
        emit: (e: string, m: string) => void;
      };
      socket.emit('echo', 'hi');
      await vi.waitFor(
        () =>
          expect(
            emitted(`socketio:event:${connectionId}`).some(
              (c) => (c[2] as { eventName: string }).eventName === 'echoed'
            )
          ).toBe(true),
        { timeout: 4_000 }
      );
      if (transports[0] === 'polling') {
        expect(seenHeaders.length).toBeGreaterThan(0);
        expect(seenHeaders.every((h) => h === 'user-secret-header')).toBe(true);
      }
    },
    10_000
  );
});
