import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Desktop (IPC-managed) lifecycle regressions:
// - #902: auto-reconnect + heartbeat must work for IPC connections, not only
//   browser sockets; a user-initiated disconnect must never reconnect.
// - #908: a Disconnect during the handshake must reach main, and a late
//   ws:open must not flip the UI back to connected.
vi.mock('@/lib/shared/platform', () => ({
  isElectron: () => true,
  getElectronAPI: vi.fn(),
}));

import { useWebSocketStore } from '@/features/websocket/store/useWebSocketStore';
import { getElectronAPI } from '@/lib/shared/platform';
import { websocketManager } from '../websocketManager';

type Listener = (payload?: unknown) => void;

function installFakeWsApi() {
  const listeners = new Map<string, Listener>();
  const connect = vi.fn(
    async (_config: {
      connectionId: string;
      url: string;
      headers?: Record<string, string>;
      protocols?: string[];
    }) => ({ success: true }) as { success: boolean; error?: string }
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
    connect,
    send,
    disconnect,
    // Captures the CURRENT listener at call time, like a real IPC event
    // arriving later; a removed listener means the event is dropped.
    emit: (channel: string, payload?: unknown) => listeners.get(channel)?.(payload),
    // Simulates main delivering an event to a listener that was captured
    // before cleanup (e.g. an event already queued in the renderer).
    capture: (channel: string) => listeners.get(channel),
  };
}

const status = (id: string) => useWebSocketStore.getState().connections[id]?.status;
const conn = (id: string) => useWebSocketStore.getState().connections[id];

describe('websocketManager on Electron', () => {
  let id: string;
  let api: ReturnType<typeof installFakeWsApi>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    api = installFakeWsApi();
    id = useWebSocketStore.getState().createConnection();
  });

  afterEach(() => {
    websocketManager.disconnect(id);
    useWebSocketStore.getState().removeConnection(id);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('handshake race (#908)', () => {
    it('sends IPC disconnect when the user disconnects while connecting', () => {
      websocketManager.connect(id, 'ws://example.com');
      expect(status(id)).toBe('connecting');

      websocketManager.disconnect(id);

      expect(api.disconnect).toHaveBeenCalledWith({ connectionId: id });
      expect(status(id)).toBe('disconnected');
    });

    it('ignores a late ws:open after a disconnect during the handshake', () => {
      websocketManager.connect(id, 'ws://example.com');
      const lateOpen = api.capture(`ws:open:${id}`);
      websocketManager.disconnect(id);

      // Listener removed: a real late IPC event is dropped.
      api.emit(`ws:open:${id}`, { protocol: '' });
      // Even a listener invoked after cleanup must not resurrect the connection.
      lateOpen?.({ protocol: '' });

      expect(status(id)).toBe('disconnected');
      expect(websocketManager.isConnected(id)).toBe(false);
    });

    it('ignores a stale open from a superseded attempt', () => {
      websocketManager.connect(id, 'ws://example.com');
      const staleOpen = api.capture(`ws:open:${id}`);
      websocketManager.connect(id, 'ws://example.com/2');
      staleOpen?.({ protocol: '' });
      expect(status(id)).toBe('connecting');
    });

    it('marks the connection disconnected when main rejects the connect', async () => {
      api.connect.mockResolvedValueOnce({ success: false, error: 'URL rejected by SSRF policy' });
      websocketManager.connect(id, 'ws://example.com');
      await vi.advanceTimersByTimeAsync(0);
      expect(status(id)).toBe('disconnected');
      expect(conn(id)?.messages.at(-1)?.content).toContain('URL rejected by SSRF policy');
      // An initial failure is not retried.
      expect(vi.getTimerCount()).toBe(0);
    });

    it('ignores the stale connect result of an attempt the user cancelled', async () => {
      let resolveConnect!: (v: { success: boolean; error?: string }) => void;
      api.connect.mockReturnValueOnce(
        new Promise((r) => {
          resolveConnect = r;
        })
      );
      websocketManager.connect(id, 'ws://example.com');
      websocketManager.disconnect(id);
      const before = conn(id)?.messages.length;
      resolveConnect({ success: false, error: 'Not connected' });
      await vi.advanceTimersByTimeAsync(0);
      expect(conn(id)?.messages.length).toBe(before);
    });
  });

  describe('auto-reconnect (#902)', () => {
    it('reconnects after an unexpected close with backoff, reusing url/headers/protocols', async () => {
      websocketManager.connect(id, 'ws://example.com', ['chat'], { Authorization: 'Bearer x' });
      api.emit(`ws:open:${id}`, { protocol: 'chat' });
      expect(status(id)).toBe('connected');

      api.emit(`ws:close:${id}`, { code: 1006, reason: '' });
      expect(status(id)).toBe('reconnecting');
      expect(conn(id)?.reconnectAttempts).toBe(1);

      const delay = conn(id)!.reconnectDelay; // attempt 1 → base delay
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(api.connect).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(api.connect).toHaveBeenCalledTimes(2);
      expect(api.connect.mock.calls[1]?.[0]).toEqual({
        connectionId: id,
        url: 'ws://example.com',
        headers: { Authorization: 'Bearer x' },
        protocols: ['chat'],
      });
      // The attempt counter survives the reconnect connect().
      expect(conn(id)?.reconnectAttempts).toBe(1);
    });

    it('doubles the delay per attempt and stops at maxReconnectAttempts', async () => {
      useWebSocketStore.setState((s) => ({
        connections: {
          ...s.connections,
          [id]: { ...s.connections[id]!, maxReconnectAttempts: 2, reconnectDelay: 100 },
        },
      }));
      websocketManager.connect(id, 'ws://example.com');
      api.emit(`ws:open:${id}`);
      api.emit(`ws:close:${id}`, { code: 1006, reason: '' });
      await vi.advanceTimersByTimeAsync(100);
      expect(api.connect).toHaveBeenCalledTimes(2);

      // Second attempt fails before opening → backoff doubles.
      api.emit(`ws:close:${id}`, { code: 1006, reason: '' });
      expect(conn(id)?.reconnectAttempts).toBe(2);
      await vi.advanceTimersByTimeAsync(199);
      expect(api.connect).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(api.connect).toHaveBeenCalledTimes(3);

      // Max reached → give up.
      api.emit(`ws:close:${id}`, { code: 1006, reason: '' });
      expect(status(id)).toBe('disconnected');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(api.connect).toHaveBeenCalledTimes(3);
    });

    it('keeps retrying when a reconnect attempt is rejected by main', async () => {
      websocketManager.connect(id, 'ws://example.com');
      api.emit(`ws:open:${id}`);
      api.emit(`ws:close:${id}`, { code: 1006, reason: '' });
      api.connect.mockResolvedValueOnce({ success: false, error: 'getaddrinfo ENOTFOUND' });
      await vi.advanceTimersByTimeAsync(conn(id)!.reconnectDelay);
      expect(api.connect).toHaveBeenCalledTimes(2);
      expect(status(id)).toBe('reconnecting');
      expect(conn(id)?.reconnectAttempts).toBe(2);
    });

    it('does not reconnect on a normal (1000) server close', async () => {
      websocketManager.connect(id, 'ws://example.com');
      api.emit(`ws:open:${id}`);
      api.emit(`ws:close:${id}`, { code: 1000, reason: 'bye' });
      expect(status(id)).toBe('disconnected');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(api.connect).toHaveBeenCalledTimes(1);
    });

    it('does not reconnect when autoReconnect is off', async () => {
      useWebSocketStore.getState().setAutoReconnect(id, false);
      websocketManager.connect(id, 'ws://example.com');
      api.emit(`ws:open:${id}`);
      api.emit(`ws:close:${id}`, { code: 1006, reason: '' });
      expect(status(id)).toBe('disconnected');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(api.connect).toHaveBeenCalledTimes(1);
    });

    it('a user-initiated disconnect never reconnects', async () => {
      websocketManager.connect(id, 'ws://example.com');
      api.emit(`ws:open:${id}`);
      websocketManager.disconnect(id);
      // Even if main still emitted a close, the listener is gone.
      api.emit(`ws:close:${id}`, { code: 1006, reason: '' });
      expect(status(id)).toBe('disconnected');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(api.connect).toHaveBeenCalledTimes(1);
    });

    it('a disconnect during the reconnect wait cancels it and settles disconnected', async () => {
      websocketManager.connect(id, 'ws://example.com');
      api.emit(`ws:open:${id}`);
      api.emit(`ws:close:${id}`, { code: 1006, reason: '' });
      expect(status(id)).toBe('reconnecting');
      websocketManager.disconnect(id);
      expect(status(id)).toBe('disconnected');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(api.connect).toHaveBeenCalledTimes(1);
    });
  });

  describe('lifecycle hygiene', () => {
    const argsOf = (cid: string) =>
      (websocketManager as unknown as { connectArgs: Map<string, unknown> }).connectArgs.get(cid);

    it('forgets the resolved connect args (incl. headers) on a user disconnect', () => {
      websocketManager.connect(id, 'ws://example.com', undefined, { Authorization: 'Bearer x' });
      api.emit(`ws:open:${id}`);
      expect(argsOf(id)).toBeDefined();
      websocketManager.disconnect(id);
      expect(argsOf(id)).toBeUndefined();
    });

    it('a manual connect during the reconnect wait cancels the stale timer', async () => {
      websocketManager.connect(id, 'ws://example.com/old');
      api.emit(`ws:open:${id}`);
      api.emit(`ws:close:${id}`, { code: 1006, reason: '' });
      expect(status(id)).toBe('reconnecting');

      websocketManager.connect(id, 'ws://example.com/new');
      api.emit(`ws:open:${id}`);
      expect(status(id)).toBe('connected');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(api.connect).toHaveBeenCalledTimes(2);
      expect(status(id)).toBe('connected');
    });

    it('a rejected IPC heartbeat send is caught and stops the heartbeat', async () => {
      const onUnhandled = vi.fn();
      process.on('unhandledRejection', onUnhandled);
      try {
        api.send.mockRejectedValue(new Error('ipc gone'));
        useWebSocketStore.getState().setHeartbeatConfig(id, 1000, 'ping');
        websocketManager.connect(id, 'ws://example.com');
        api.emit(`ws:open:${id}`);
        await vi.advanceTimersByTimeAsync(3000);
        expect(api.send).toHaveBeenCalledTimes(1);
        expect(onUnhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });
  });

  describe('heartbeat (#902)', () => {
    it('sends the heartbeat message over IPC on the configured interval', async () => {
      useWebSocketStore.getState().setHeartbeatConfig(id, 1000, 'ping!');
      websocketManager.connect(id, 'ws://example.com');
      await vi.advanceTimersByTimeAsync(3000);
      expect(api.send).not.toHaveBeenCalled(); // not before open

      api.emit(`ws:open:${id}`);
      await vi.advanceTimersByTimeAsync(2000);
      expect(api.send).toHaveBeenCalledTimes(2);
      expect(api.send).toHaveBeenCalledWith({ connectionId: id, message: 'ping!' });
    });

    it('stops the heartbeat on close and on disconnect', async () => {
      useWebSocketStore.getState().setHeartbeatConfig(id, 1000, 'ping');
      useWebSocketStore.getState().setAutoReconnect(id, false);
      websocketManager.connect(id, 'ws://example.com');
      api.emit(`ws:open:${id}`);
      api.emit(`ws:close:${id}`, { code: 1006, reason: '' });
      await vi.advanceTimersByTimeAsync(5000);
      expect(api.send).not.toHaveBeenCalled();

      websocketManager.connect(id, 'ws://example.com');
      api.emit(`ws:open:${id}`);
      websocketManager.disconnect(id);
      await vi.advanceTimersByTimeAsync(5000);
      expect(api.send).not.toHaveBeenCalled();
    });

    it('updateHeartbeat starts a heartbeat on an open IPC connection', async () => {
      websocketManager.connect(id, 'ws://example.com');
      api.emit(`ws:open:${id}`);
      websocketManager.updateHeartbeat(id, 500, 'hb');
      await vi.advanceTimersByTimeAsync(500);
      expect(api.send).toHaveBeenCalledWith({ connectionId: id, message: 'hb' });
    });
  });
});
