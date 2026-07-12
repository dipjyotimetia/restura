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
//      family (http vs https) follows the URL scheme.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';

const mockHandle = vi.hoisted(() => vi.fn());
const mockResolveSafe = vi.hoisted(() => vi.fn());
const mockCreatePinnedLookup = vi.hoisted(() => vi.fn(() => () => undefined));
const mockIo = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, removeHandler: vi.fn() },
}));
vi.mock('../../electron/main/security/safe-connect', () => ({
  resolveSafeAddress: mockResolveSafe,
  createPinnedLookup: mockCreatePinnedLookup,
}));
vi.mock('socket.io-client', () => ({ io: mockIo }));
vi.mock('../../electron/main/ipc/ipc-utils', () => ({ emitTo: vi.fn() }));
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
  SocketIoConnectSchema: {},
  SocketIoEmitSchema: {},
  SocketIoDisconnectSchema: {},
}));

import { registerSocketIoHandlerIPC } from '../../electron/main/handlers/socketio-handler';
import { IPC } from '../../electron/shared/channels';
import { setExecutionPolicy } from '../../electron/main/security/execution-policy';

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
