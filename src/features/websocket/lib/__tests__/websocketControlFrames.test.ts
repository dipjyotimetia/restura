import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Control-frame wiring in the renderer manager: custom close code/reason
// (#915), desktop ping/pong + RTT (#919), negotiated subprotocol/extensions and
// the permessage-deflate toggle (#923). One file drives both platforms via a
// mutable platform mock.
const platform = vi.hoisted(() => ({ electron: false, api: undefined as unknown }));
vi.mock('@/lib/shared/platform', () => ({
  isElectron: () => platform.electron,
  getElectronAPI: () => platform.api,
}));

import { useWebSocketStore } from '@/features/websocket/store/useWebSocketStore';
import { websocketManager } from '../websocketManager';

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.CONNECTING;
  binaryType = 'blob';
  protocol = '';
  extensions = '';
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }
}

type Listener = (payload?: unknown) => void;
function installElectronApi() {
  const listeners = new Map<string, Listener>();
  const websocket = {
    connect: vi.fn(async () => ({ success: true })),
    send: vi.fn(async () => ({ success: true })),
    ping: vi.fn(async () => ({ success: true }) as { success: boolean; error?: string }),
    disconnect: vi.fn(async () => ({ success: true })),
    on: vi.fn((channel: string, cb: Listener) => listeners.set(channel, cb)),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn((channel: string) => listeners.delete(channel)),
  };
  platform.electron = true;
  platform.api = { websocket };
  return { websocket, emit: (ch: string, p?: unknown) => listeners.get(ch)?.(p), listeners };
}

const originalWebSocket = globalThis.WebSocket;
let connectionId: string;

const conn = () => useWebSocketStore.getState().connections[connectionId]!;
const lastMessage = () => conn().messages.at(-1)?.content;

beforeEach(() => {
  platform.electron = false;
  platform.api = undefined;
  MockWebSocket.instances.length = 0;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
  connectionId = useWebSocketStore.getState().createConnection();
});

afterEach(() => {
  websocketManager.disconnect(connectionId);
  useWebSocketStore.getState().removeConnection(connectionId);
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
  vi.clearAllMocks();
});

describe('web (browser WebSocket)', () => {
  it('closes with the chosen code and reason and logs it (#915)', () => {
    websocketManager.connect(connectionId, 'wss://echo.example.com/');
    const ws = MockWebSocket.instances[0]!;
    websocketManager.disconnect(connectionId, true, { code: 4002, reason: 'done' });
    expect(ws.close).toHaveBeenCalledWith(4002, 'done');
    expect(lastMessage()).toBe('Closing (code: 4002, reason: done)');
    expect(conn().status).toBe('disconnected');
  });

  it('keeps the default close frame without options', () => {
    websocketManager.connect(connectionId, 'wss://echo.example.com/');
    const ws = MockWebSocket.instances[0]!;
    websocketManager.disconnect(connectionId);
    expect(ws.close).toHaveBeenCalledWith(1000, 'Client disconnected');
  });

  it('surfaces the negotiated subprotocol and extensions on open (#923)', () => {
    websocketManager.connect(connectionId, 'wss://echo.example.com/');
    const ws = MockWebSocket.instances[0]!;
    ws.protocol = 'graphql-transport-ws';
    ws.extensions = 'permessage-deflate';
    ws.onopen?.();
    expect(conn().negotiated).toEqual({
      protocol: 'graphql-transport-ws',
      extensions: 'permessage-deflate',
    });
    expect(lastMessage()).toBe(
      'Connected to wss://echo.example.com/ (subprotocol: graphql-transport-ws; extensions: permessage-deflate)'
    );
  });

  it('refuses to ping on web and says why (#919)', () => {
    expect(websocketManager.ping(connectionId, '')).toBe(false);
    expect(lastMessage()).toMatch(/browser WebSocket API/);
  });
});

describe('desktop (IPC bridge)', () => {
  it('passes the close code/reason to ws:disconnect (#915)', () => {
    const { websocket, emit } = installElectronApi();
    websocketManager.connect(connectionId, 'wss://echo.example.com/');
    emit(`ws:open:${connectionId}`, { protocol: '', extensions: '' });
    websocketManager.disconnect(connectionId, true, { code: 3001, reason: 'bye' });
    expect(websocket.disconnect).toHaveBeenCalledWith({
      connectionId,
      code: 3001,
      reason: 'bye',
    });
  });

  it('offers permessage-deflate by default and honours the per-connection toggle (#923)', () => {
    const { websocket } = installElectronApi();
    websocketManager.connect(connectionId, 'wss://echo.example.com/');
    expect(websocket.connect).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ perMessageDeflate: false })
    );

    useWebSocketStore.getState().patchControlState(connectionId, { perMessageDeflate: false });
    websocketManager.connect(connectionId, 'wss://echo.example.com/');
    expect(websocket.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({ perMessageDeflate: false })
    );
  });

  it('records the negotiated protocol/extensions from the ws:open payload', () => {
    const { emit } = installElectronApi();
    websocketManager.connect(connectionId, 'wss://echo.example.com/');
    emit(`ws:open:${connectionId}`, { protocol: 'mqtt', extensions: '' });
    expect(conn().negotiated).toEqual({ protocol: 'mqtt', extensions: '' });
    expect(lastMessage()).toBe('Connected to wss://echo.example.com/ (subprotocol: mqtt)');
  });

  it('sends a ping and logs pong RTT + server pings as system entries (#919)', async () => {
    const { websocket, emit } = installElectronApi();
    websocketManager.connect(connectionId, 'wss://echo.example.com/');
    emit(`ws:open:${connectionId}`, { protocol: '', extensions: '' });

    expect(websocketManager.ping(connectionId, 'hi')).toBe(true);
    expect(websocket.ping).toHaveBeenCalledWith({ connectionId, payload: 'hi' });
    await Promise.resolve();
    expect(lastMessage()).toBe('Ping sent (payload: hi)');

    emit(`ws:pong:${connectionId}`, { data: 'hi', rttMs: 17 });
    expect(lastMessage()).toBe('Pong received · RTT 17 ms (payload: hi)');
    expect(conn().lastPingRttMs).toBe(17);

    emit(`ws:pong:${connectionId}`, { data: '' });
    expect(lastMessage()).toBe('Pong received (unsolicited)');

    emit(`ws:ping-received:${connectionId}`, { data: '' });
    expect(lastMessage()).toBe('Ping received from server (auto-replied with pong)');
  });

  it('clears the last ping RTT when the connection ends (no stale latency)', () => {
    const { emit } = installElectronApi();
    websocketManager.connect(connectionId, 'wss://echo.example.com/');
    emit(`ws:open:${connectionId}`, { protocol: '', extensions: '' });
    emit(`ws:pong:${connectionId}`, { data: '', rttMs: 12 });
    expect(conn().lastPingRttMs).toBe(12);
    websocketManager.disconnect(connectionId);
    expect(conn().lastPingRttMs).toBeUndefined();

    websocketManager.connect(connectionId, 'wss://echo.example.com/');
    emit(`ws:open:${connectionId}`, { protocol: '', extensions: '' });
    emit(`ws:pong:${connectionId}`, { data: '', rttMs: 8 });
    useWebSocketStore.getState().setAutoReconnect(connectionId, false);
    emit(`ws:close:${connectionId}`, { code: 1006, reason: '' });
    expect(conn().lastPingRttMs).toBeUndefined();
  });

  it('logs a failed ping and rejects an oversized payload without IPC', async () => {
    const { websocket, emit } = installElectronApi();
    websocketManager.connect(connectionId, 'wss://echo.example.com/');
    emit(`ws:open:${connectionId}`, { protocol: '', extensions: '' });

    expect(websocketManager.ping(connectionId, 'a'.repeat(126))).toBe(false);
    expect(websocket.ping).not.toHaveBeenCalled();
    expect(lastMessage()).toMatch(/125 bytes/);

    websocket.ping.mockResolvedValueOnce({ success: false, error: 'Not connected' });
    websocketManager.ping(connectionId, '');
    await Promise.resolve();
    await Promise.resolve();
    expect(lastMessage()).toBe('Ping failed: Not connected');
  });

  it('removes the control-frame listeners on disconnect', () => {
    const { listeners, emit } = installElectronApi();
    websocketManager.connect(connectionId, 'wss://echo.example.com/');
    emit(`ws:open:${connectionId}`, { protocol: '', extensions: '' });
    expect(listeners.has(`ws:pong:${connectionId}`)).toBe(true);
    websocketManager.disconnect(connectionId);
    expect(listeners.has(`ws:pong:${connectionId}`)).toBe(false);
    expect(listeners.has(`ws:ping-received:${connectionId}`)).toBe(false);
  });
});
