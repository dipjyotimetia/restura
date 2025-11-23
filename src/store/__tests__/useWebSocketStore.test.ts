import { describe, it, expect, beforeEach } from 'vitest';
import { useWebSocketStore } from '../useWebSocketStore';

describe('useWebSocketStore', () => {
  beforeEach(() => {
    // Reset store state
    const store = useWebSocketStore.getState();
    Object.keys(store.connections).forEach((id) => {
      store.deleteConnection(id);
    });
  });

  describe('connection management', () => {
    it('should create a new connection', () => {
      const id = useWebSocketStore.getState().createConnection();

      expect(id).toBeDefined();
      const state = useWebSocketStore.getState();
      expect(state.connections[id]).toBeDefined();
      expect(state.activeConnectionId).toBe(id);
    });

    it('should create connection with default values', () => {
      const id = useWebSocketStore.getState().createConnection();
      const connection = useWebSocketStore.getState().connections[id];

      expect(connection!.url).toBe('');
      expect(connection!.status).toBe('disconnected');
      expect(connection!.messages).toEqual([]);
      expect(connection!.headers).toEqual([]);
      expect(connection!.protocols).toEqual([]);
      expect(connection!.autoReconnect).toBe(true);
      expect(connection!.reconnectAttempts).toBe(0);
      expect(connection!.maxReconnectAttempts).toBe(5);
    });

    it('should create connection with custom URL', () => {
      const id = useWebSocketStore.getState().createConnection('ws://localhost:8080');
      const connection = useWebSocketStore.getState().connections[id];

      expect(connection!.url).toBe('ws://localhost:8080');
    });

    it('should delete connection', () => {
      const store = useWebSocketStore.getState();
      const id = store.createConnection();

      store.deleteConnection(id);

      expect(useWebSocketStore.getState().connections[id]).toBeUndefined();
    });

    it('should clear activeConnectionId when deleting active connection', () => {
      const id = useWebSocketStore.getState().createConnection();

      expect(useWebSocketStore.getState().activeConnectionId).toBe(id);

      useWebSocketStore.getState().deleteConnection(id);

      expect(useWebSocketStore.getState().activeConnectionId).toBeNull();
    });

    it('should set active connection', () => {
      const store = useWebSocketStore.getState();
      const id1 = store.createConnection();
      store.createConnection(); // Create second connection

      store.setActiveConnection(id1);
      expect(useWebSocketStore.getState().activeConnectionId).toBe(id1);
    });
  });

  describe('connection state updates', () => {
    let connectionId: string;

    beforeEach(() => {
      connectionId = useWebSocketStore.getState().createConnection();
    });

    it('should update connection status', () => {
      useWebSocketStore.getState().updateConnectionStatus(connectionId, 'connecting');
      expect(useWebSocketStore.getState().connections[connectionId]?.status).toBe('connecting');

      useWebSocketStore.getState().updateConnectionStatus(connectionId, 'connected');
      expect(useWebSocketStore.getState().connections[connectionId]?.status).toBe('connected');
    });

    it('should update connection URL', () => {
      const store = useWebSocketStore.getState();

      store.updateConnectionUrl(connectionId, 'wss://example.com');
      expect(useWebSocketStore.getState().connections[connectionId]?.url).toBe('wss://example.com');
    });

    it('should set reconnect attempts', () => {
      const store = useWebSocketStore.getState();

      store.setReconnectAttempts(connectionId, 3);
      expect(useWebSocketStore.getState().connections[connectionId]?.reconnectAttempts).toBe(3);
    });

    it('should set auto reconnect', () => {
      const store = useWebSocketStore.getState();

      store.setAutoReconnect(connectionId, false);
      expect(useWebSocketStore.getState().connections[connectionId]?.autoReconnect).toBe(false);
    });

    it('should set last connected at', () => {
      const store = useWebSocketStore.getState();
      const timestamp = Date.now();

      store.setLastConnectedAt(connectionId, timestamp);
      expect(useWebSocketStore.getState().connections[connectionId]?.lastConnectedAt).toBe(timestamp);
    });
  });

  describe('messages', () => {
    let connectionId: string;

    beforeEach(() => {
      connectionId = useWebSocketStore.getState().createConnection();
    });

    it('should add text message', () => {
      const store = useWebSocketStore.getState();

      store.addMessage(connectionId, 'sent', 'Hello', 'text');

      const connection = useWebSocketStore.getState().connections[connectionId];
      expect(connection!.messages).toHaveLength(1);
      expect(connection!.messages[0]?.type).toBe('sent');
      expect(connection!.messages[0]?.content).toBe('Hello');
      expect(connection!.messages[0]?.dataType).toBe('text');
    });

    it('should add binary message', () => {
      const store = useWebSocketStore.getState();
      const buffer = new Uint8Array([1, 2, 3]).buffer;

      store.addMessage(connectionId, 'received', '01 02 03', 'binary', buffer);

      const connection = useWebSocketStore.getState().connections[connectionId];
      expect(connection!.messages).toHaveLength(1);
      expect(connection!.messages[0]?.dataType).toBe('binary');
      expect(connection!.messages[0]?.binaryData).toBe(buffer);
    });

    it('should add system message', () => {
      const store = useWebSocketStore.getState();

      store.addMessage(connectionId, 'system', 'Connected');

      const connection = useWebSocketStore.getState().connections[connectionId];
      expect(connection!.messages[0]?.type).toBe('system');
    });

    it('should clear messages', () => {
      const store = useWebSocketStore.getState();

      store.addMessage(connectionId, 'sent', 'Test 1');
      store.addMessage(connectionId, 'received', 'Test 2');

      store.clearMessages(connectionId);

      const connection = useWebSocketStore.getState().connections[connectionId];
      expect(connection!.messages).toHaveLength(0);
    });

    it('should limit messages to MAX_MESSAGES_PER_CONNECTION', () => {
      const store = useWebSocketStore.getState();

      // Add more than max messages
      for (let i = 0; i < 1010; i++) {
        store.addMessage(connectionId, 'sent', `Message ${i}`);
      }

      const connection = useWebSocketStore.getState().connections[connectionId];
      expect(connection!.messages.length).toBeLessThanOrEqual(1000);
    });
  });

  describe('headers', () => {
    let connectionId: string;

    beforeEach(() => {
      connectionId = useWebSocketStore.getState().createConnection();
    });

    it('should add header', () => {
      const store = useWebSocketStore.getState();

      store.addHeader(connectionId);

      const connection = useWebSocketStore.getState().connections[connectionId];
      expect(connection!.headers).toHaveLength(1);
      expect(connection!.headers[0]?.key).toBe('');
      expect(connection!.headers[0]?.value).toBe('');
      expect(connection!.headers[0]?.enabled).toBe(true);
    });

    it('should update header', () => {
      const store = useWebSocketStore.getState();

      store.addHeader(connectionId);
      const headerId = useWebSocketStore.getState().connections[connectionId]!.headers[0]!.id;

      store.updateHeader(connectionId, headerId, { key: 'Authorization', value: 'Bearer token' });

      const connection = useWebSocketStore.getState().connections[connectionId];
      expect(connection!.headers[0]?.key).toBe('Authorization');
      expect(connection!.headers[0]?.value).toBe('Bearer token');
    });

    it('should delete header', () => {
      const store = useWebSocketStore.getState();

      store.addHeader(connectionId);
      const headerId = useWebSocketStore.getState().connections[connectionId]!.headers[0]!.id;

      store.deleteHeader(connectionId, headerId);

      const connection = useWebSocketStore.getState().connections[connectionId];
      expect(connection!.headers).toHaveLength(0);
    });
  });

  describe('protocols', () => {
    let connectionId: string;

    beforeEach(() => {
      connectionId = useWebSocketStore.getState().createConnection();
    });

    it('should set protocols', () => {
      const store = useWebSocketStore.getState();

      store.setProtocols(connectionId, ['graphql-ws', 'chat']);

      const connection = useWebSocketStore.getState().connections[connectionId];
      expect(connection!.protocols).toEqual(['graphql-ws', 'chat']);
    });
  });

  describe('filtering', () => {
    let connectionId: string;

    beforeEach(() => {
      connectionId = useWebSocketStore.getState().createConnection();
      const store = useWebSocketStore.getState();

      // Reset filter state
      store.setMessageFilter('all');
      store.setSearchQuery('');

      store.addMessage(connectionId, 'sent', 'Hello world');
      store.addMessage(connectionId, 'received', 'World hello');
      store.addMessage(connectionId, 'system', 'Connected');
    });

    it('should filter by message type', () => {
      const store = useWebSocketStore.getState();

      store.setMessageFilter('sent');
      const filtered = store.getFilteredMessages(connectionId);

      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.type).toBe('sent');
    });

    it('should filter by search query', () => {
      const store = useWebSocketStore.getState();

      store.setSearchQuery('hello');
      const filtered = store.getFilteredMessages(connectionId);

      expect(filtered).toHaveLength(2);
    });

    it('should return all messages when filter is "all"', () => {
      const store = useWebSocketStore.getState();

      store.setMessageFilter('all');
      store.setSearchQuery('');
      const filtered = store.getFilteredMessages(connectionId);

      expect(filtered).toHaveLength(3);
    });

    it('should combine type and search filters', () => {
      const store = useWebSocketStore.getState();

      store.setMessageFilter('sent');
      store.setSearchQuery('world');
      const filtered = store.getFilteredMessages(connectionId);

      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.content).toBe('Hello world');
    });

    it('should be case insensitive for search', () => {
      const store = useWebSocketStore.getState();

      store.setSearchQuery('HELLO');
      const filtered = store.getFilteredMessages(connectionId);

      expect(filtered).toHaveLength(2);
    });
  });

  describe('getActiveConnection', () => {
    it('should return null when no active connection', () => {
      const store = useWebSocketStore.getState();
      expect(store.getActiveConnection()).toBeNull();
    });

    it('should return active connection', () => {
      const store = useWebSocketStore.getState();
      const id = store.createConnection('ws://test.com');

      const active = store.getActiveConnection();
      expect(active).toBeDefined();
      expect(active?.id).toBe(id);
      expect(active?.url).toBe('ws://test.com');
    });
  });
});
