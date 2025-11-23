import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { websocketManager } from '../websocketManager';
import { useWebSocketStore } from '@/store/useWebSocketStore';

// Mock WebSocket
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  binaryType = 'blob';
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(
    public url: string,
    public protocols?: string | string[]
  ) {}

  send = vi.fn();
  close = vi.fn();
}

// Replace global WebSocket
const originalWebSocket = global.WebSocket;
beforeEach(() => {
  (global as unknown as { WebSocket: typeof MockWebSocket }).WebSocket = MockWebSocket;
});

afterEach(() => {
  (global as unknown as { WebSocket: typeof WebSocket }).WebSocket = originalWebSocket;
  vi.clearAllMocks();
});

describe('WebSocketManager', () => {
  describe('URL validation', () => {
    let connectionId: string;

    beforeEach(() => {
      // Create a connection in the store
      connectionId = useWebSocketStore.getState().createConnection();
    });

    afterEach(() => {
      useWebSocketStore.getState().deleteConnection(connectionId);
    });

    it('should reject empty URL', () => {
      websocketManager.connect(connectionId, '');

      const connection = useWebSocketStore.getState().connections[connectionId];
      expect(connection?.status).toBe('disconnected');
      expect(connection?.messages[0]?.content).toContain('URL is required');
    });

    it('should reject non-websocket protocols', () => {
      websocketManager.connect(connectionId, 'http://example.com');

      const connection = useWebSocketStore.getState().connections[connectionId];
      expect(connection?.status).toBe('disconnected');
      expect(connection?.messages[0]?.content).toContain('Invalid protocol');
    });

    it('should reject invalid URL format', () => {
      websocketManager.connect(connectionId, 'not-a-valid-url');

      const connection = useWebSocketStore.getState().connections[connectionId];
      expect(connection?.status).toBe('disconnected');
      expect(connection?.messages[0]?.content).toContain('Invalid URL format');
    });

    it('should accept ws:// URLs', () => {
      websocketManager.connect(connectionId, 'ws://localhost:8080');

      const connection = useWebSocketStore.getState().connections[connectionId];
      expect(connection?.status).toBe('connecting');
    });

    it('should accept wss:// URLs', () => {
      websocketManager.connect(connectionId, 'wss://example.com/socket');

      const connection = useWebSocketStore.getState().connections[connectionId];
      expect(connection?.status).toBe('connecting');
    });
  });

  describe('hexToArrayBuffer', () => {
    it('should convert valid hex string to ArrayBuffer', () => {
      const hex = '48 65 6c 6c 6f';
      const buffer = websocketManager.hexToArrayBuffer(hex);
      const bytes = new Uint8Array(buffer);

      expect(bytes).toEqual(new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]));
    });

    it('should handle single byte', () => {
      const hex = 'ff';
      const buffer = websocketManager.hexToArrayBuffer(hex);
      const bytes = new Uint8Array(buffer);

      expect(bytes).toEqual(new Uint8Array([0xff]));
    });

    it('should handle multiple spaces between bytes', () => {
      const hex = '01  02   03';
      const buffer = websocketManager.hexToArrayBuffer(hex);
      const bytes = new Uint8Array(buffer);

      expect(bytes).toEqual(new Uint8Array([0x01, 0x02, 0x03]));
    });

    it('should handle empty string', () => {
      const hex = '';
      const buffer = websocketManager.hexToArrayBuffer(hex);
      const bytes = new Uint8Array(buffer);

      expect(bytes.length).toBe(0);
    });
  });

  describe('connection lifecycle', () => {
    let connectionId: string;

    beforeEach(() => {
      connectionId = useWebSocketStore.getState().createConnection();
    });

    afterEach(() => {
      websocketManager.disconnect(connectionId);
      useWebSocketStore.getState().deleteConnection(connectionId);
    });

    it('should set status to connecting when connect is called', () => {
      websocketManager.connect(connectionId, 'ws://localhost:8080');

      const connection = useWebSocketStore.getState().connections[connectionId];
      expect(connection?.status).toBe('connecting');
    });

    it('should pass protocols to WebSocket constructor', () => {
      websocketManager.connect(connectionId, 'ws://localhost:8080', ['graphql-ws']);

      // The MockWebSocket should have been created with protocols
      const ws = websocketManager.getConnection(connectionId);
      expect(ws).toBeDefined();
      expect((ws as unknown as MockWebSocket).protocols).toEqual(['graphql-ws']);
    });

    it('should set binaryType to arraybuffer', () => {
      websocketManager.connect(connectionId, 'ws://localhost:8080');

      const ws = websocketManager.getConnection(connectionId);
      expect(ws?.binaryType).toBe('arraybuffer');
    });

    it('should disconnect and clear connection', () => {
      websocketManager.connect(connectionId, 'ws://localhost:8080');
      websocketManager.disconnect(connectionId);

      const ws = websocketManager.getConnection(connectionId);
      expect(ws).toBeUndefined();

      const connection = useWebSocketStore.getState().connections[connectionId];
      expect(connection?.status).toBe('disconnected');
    });

    it('should report connection status correctly', () => {
      expect(websocketManager.isConnected(connectionId)).toBe(false);

      websocketManager.connect(connectionId, 'ws://localhost:8080');

      // Still connecting, not open
      expect(websocketManager.isConnected(connectionId)).toBe(false);

      // Simulate connection open
      const ws = websocketManager.getConnection(connectionId) as unknown as MockWebSocket;
      ws.readyState = MockWebSocket.OPEN;

      expect(websocketManager.isConnected(connectionId)).toBe(true);
    });
  });

  describe('message sending', () => {
    let connectionId: string;

    beforeEach(() => {
      connectionId = useWebSocketStore.getState().createConnection();
      websocketManager.connect(connectionId, 'ws://localhost:8080');
    });

    afterEach(() => {
      websocketManager.disconnect(connectionId);
      useWebSocketStore.getState().deleteConnection(connectionId);
    });

    it('should not send when not connected', () => {
      const result = websocketManager.send(connectionId, 'test');
      expect(result).toBe(false);
    });

    it('should send text message when connected', () => {
      const ws = websocketManager.getConnection(connectionId) as unknown as MockWebSocket;
      ws.readyState = MockWebSocket.OPEN;

      const result = websocketManager.send(connectionId, 'hello');
      expect(result).toBe(true);
      expect(ws.send).toHaveBeenCalledWith('hello');

      const connection = useWebSocketStore.getState().connections[connectionId];
      const lastMessage = connection!.messages[connection!.messages.length - 1];
      expect(lastMessage?.type).toBe('sent');
      expect(lastMessage?.content).toBe('hello');
      expect(lastMessage?.dataType).toBe('text');
    });

    it('should send binary message when connected', () => {
      const ws = websocketManager.getConnection(connectionId) as unknown as MockWebSocket;
      ws.readyState = MockWebSocket.OPEN;

      const buffer = new Uint8Array([1, 2, 3]).buffer;
      const result = websocketManager.send(connectionId, buffer);
      expect(result).toBe(true);
      expect(ws.send).toHaveBeenCalledWith(buffer);

      const connection = useWebSocketStore.getState().connections[connectionId];
      const lastMessage = connection!.messages[connection!.messages.length - 1];
      expect(lastMessage?.type).toBe('sent');
      expect(lastMessage?.dataType).toBe('binary');
    });
  });
});
