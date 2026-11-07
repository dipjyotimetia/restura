import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWebSocketStore } from '@/features/websocket/store/useWebSocketStore';
import { describeWebSocketHandshakeFailure, websocketManager } from '../websocketManager';

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = MockWebSocket.CONNECTING;
  binaryType = 'blob';
  protocol = '';
  extensions = '';
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
  }
  send = vi.fn();
  close = vi.fn();
}

const originalWebSocket = global.WebSocket;
let connectionId: string;

beforeEach(() => {
  (global as unknown as { WebSocket: typeof MockWebSocket }).WebSocket = MockWebSocket;
  connectionId = useWebSocketStore.getState().createConnection();
  useWebSocketStore.getState().setAutoReconnect(connectionId, false);
});

afterEach(() => {
  websocketManager.disconnect(connectionId);
  useWebSocketStore.getState().removeConnection(connectionId);
  (global as unknown as { WebSocket: typeof WebSocket }).WebSocket = originalWebSocket;
});

const contents = () =>
  (useWebSocketStore.getState().connections[connectionId]?.messages ?? []).map((m) => m.content);

describe('WebSocket handshake failure (1006 before open)', () => {
  it('replaces the raw error with likely causes', () => {
    websocketManager.connect(connectionId, 'wss://api.example.com/socket');
    const ws = websocketManager.getConnection(connectionId) as unknown as MockWebSocket;
    ws.onerror?.(new Event('error'));
    ws.onclose?.({ code: 1006, reason: '' } as CloseEvent);
    const log = contents().join('\n');
    expect(log).not.toContain('WebSocket error occurred');
    expect(log).toContain('Could not open the WebSocket to wss://api.example.com/socket');
    expect(log).toMatch(/unreachable/i);
    expect(log).toMatch(/TLS|certificate/i);
    expect(log).toMatch(/Origin/);
    expect(log).toMatch(/private|local network/i);
  });

  it('keeps the plain close message for a drop after the socket opened', () => {
    websocketManager.connect(connectionId, 'wss://api.example.com/socket');
    const ws = websocketManager.getConnection(connectionId) as unknown as MockWebSocket;
    ws.readyState = MockWebSocket.OPEN;
    ws.onopen?.(new Event('open'));
    ws.onclose?.({ code: 1006, reason: '' } as CloseEvent);
    expect(contents().join('\n')).not.toContain('Could not open the WebSocket');
  });

  it('only mentions TLS for wss:// URLs', () => {
    expect(describeWebSocketHandshakeFailure('ws://h:1/x')).not.toMatch(/certificate/i);
    expect(describeWebSocketHandshakeFailure('wss://h/x')).toMatch(/certificate/i);
  });
});
