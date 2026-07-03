import { describe, it, expect, vi, beforeEach } from 'vitest';

// The web-only native WebSocket path is CSP-blocked (ws:) or SSRF-unguarded
// (wss:) on Electron — the bug this test guards against regressing.
// `websocketStartStream` must route through the `ws:connect` IPC bridge
// instead of ever constructing `new WebSocket(...)` under Electron.
const NativeWebSocket = vi.hoisted(() => vi.fn());
vi.stubGlobal('WebSocket', NativeWebSocket);

vi.mock('@/lib/shared/platform', () => ({
  isElectron: () => true,
  getElectronAPI: vi.fn(),
}));

import { websocketProtocol } from '../../protocol';
import { getElectronAPI } from '@/lib/shared/platform';

type Listener = (payload?: unknown) => void;

function installFakeWsApi() {
  const listeners = new Map<string, Listener>();
  const connect = vi.fn(
    async (_config: { connectionId: string; url: string }) =>
      ({ success: true }) as { success: boolean; error?: string }
  );
  const send = vi.fn(async () => ({ success: true }));
  const disconnect = vi.fn(async () => ({ success: true }));
  const websocket = {
    connect,
    send,
    disconnect,
    on: vi.fn((channel: string, cb: Listener) => {
      listeners.set(channel, cb);
    }),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn((channel: string) => {
      listeners.delete(channel);
    }),
  };
  vi.mocked(getElectronAPI).mockReturnValue({ websocket } as never);
  return {
    websocket,
    connect,
    send,
    disconnect,
    emit: (channel: string, payload?: unknown) => listeners.get(channel)?.(payload),
  };
}

describe('websocketProtocol.startStream on Electron', () => {
  beforeEach(() => {
    NativeWebSocket.mockReset();
  });

  it('connects via the ws:connect IPC channel, never a native WebSocket', async () => {
    const api = installFakeWsApi();
    const request = { type: 'websocket' as const, url: 'wss://example.com/socket' };
    const openPromise = websocketProtocol.startStream!(request, {
      signal: new AbortController().signal,
      variables: {},
    });

    // startStream resolves only after `ws:open` — fire it once connect() has
    // been called (mirrors the main process emitting the event async).
    await Promise.resolve();
    const connectionId = api.connect.mock.calls[0]![0].connectionId;
    api.emit(`ws:open:${connectionId}`);

    const handle = await openPromise;
    expect(api.connect).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'wss://example.com/socket' })
    );
    expect(NativeWebSocket).not.toHaveBeenCalled();

    await handle.close();
    expect(api.disconnect).toHaveBeenCalled();
  });

  it('sends frames through the IPC send channel', async () => {
    const api = installFakeWsApi();
    const request = { type: 'websocket' as const, url: 'wss://example.com/socket' };
    const openPromise = websocketProtocol.startStream!(request, {
      signal: new AbortController().signal,
      variables: {},
    });
    await Promise.resolve();
    const connectionId = api.connect.mock.calls[0]![0].connectionId;
    api.emit(`ws:open:${connectionId}`);
    const handle = await openPromise;

    (handle as unknown as { send: (frame: string) => void }).send('{"hello":"world"}');
    expect(api.send).toHaveBeenCalledWith({
      connectionId,
      message: '{"hello":"world"}',
    });
  });

  it('rejects the connection if it closes before ever opening', async () => {
    const api = installFakeWsApi();
    const request = { type: 'websocket' as const, url: 'wss://example.com/socket' };
    const openPromise = websocketProtocol.startStream!(request, {
      signal: new AbortController().signal,
      variables: {},
    });
    await Promise.resolve();
    const connectionId = api.connect.mock.calls[0]![0].connectionId;
    api.emit(`ws:error:${connectionId}`, { message: 'handshake failed' });
    api.emit(`ws:close:${connectionId}`);

    await expect(openPromise).rejects.toThrow('handshake failed');
  });
});
