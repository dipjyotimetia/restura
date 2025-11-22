import { useWebSocketStore } from '@/store/useWebSocketStore';

// Singleton manager for WebSocket connections
class WebSocketManager {
  private connections: Map<string, WebSocket> = new Map();
  private reconnectTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private connectionTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private static DEFAULT_CONNECTION_TIMEOUT = 30000; // 30 seconds

  // Validate WebSocket URL
  private validateUrl(url: string): { valid: boolean; error?: string } {
    if (!url || !url.trim()) {
      return { valid: false, error: 'URL is required' };
    }

    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
        return {
          valid: false,
          error: `Invalid protocol "${parsed.protocol}". URL must start with ws:// or wss://`,
        };
      }
      return { valid: true };
    } catch {
      return { valid: false, error: 'Invalid URL format' };
    }
  }

  connect(connectionId: string, url: string, protocols?: string[]): void {
    // Close existing connection if any
    this.disconnect(connectionId, false);

    const store = useWebSocketStore.getState();

    // Validate URL before attempting connection
    const validation = this.validateUrl(url);
    if (!validation.valid) {
      store.addMessage(connectionId, 'system', `Connection failed: ${validation.error}`);
      store.updateConnectionStatus(connectionId, 'disconnected');
      return;
    }

    store.updateConnectionStatus(connectionId, 'connecting');
    store.setReconnectAttempts(connectionId, 0);

    try {
      const ws = protocols?.length
        ? new WebSocket(url, protocols)
        : new WebSocket(url);

      // Set connection timeout
      const timeoutId = setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.close();
          store.addMessage(
            connectionId,
            'system',
            `Connection timeout after ${WebSocketManager.DEFAULT_CONNECTION_TIMEOUT / 1000}s`
          );
          store.updateConnectionStatus(connectionId, 'disconnected');
          this.connections.delete(connectionId);
          this.connectionTimeouts.delete(connectionId);
        }
      }, WebSocketManager.DEFAULT_CONNECTION_TIMEOUT);

      this.connectionTimeouts.set(connectionId, timeoutId);

      // Set binary type to arraybuffer for binary message support
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        // Clear connection timeout
        const timeout = this.connectionTimeouts.get(connectionId);
        if (timeout) {
          clearTimeout(timeout);
          this.connectionTimeouts.delete(connectionId);
        }

        const state = useWebSocketStore.getState();
        state.updateConnectionStatus(connectionId, 'connected');
        state.setReconnectAttempts(connectionId, 0);
        state.setLastConnectedAt(connectionId, Date.now());
        state.addMessage(connectionId, 'system', `Connected to ${url}`);
      };

      ws.onmessage = (event) => {
        const state = useWebSocketStore.getState();

        if (event.data instanceof ArrayBuffer) {
          // Binary message
          const hexString = this.arrayBufferToHex(event.data);
          state.addMessage(
            connectionId,
            'received',
            hexString,
            'binary',
            event.data
          );
        } else {
          // Text message
          state.addMessage(connectionId, 'received', event.data, 'text');
        }
      };

      ws.onerror = (error) => {
        const state = useWebSocketStore.getState();
        state.addMessage(connectionId, 'system', 'WebSocket error occurred');
        console.error('WebSocket error:', error);
      };

      ws.onclose = (event) => {
        const state = useWebSocketStore.getState();
        const connection = state.connections[connectionId];

        state.addMessage(
          connectionId,
          'system',
          `Connection closed (code: ${event.code}, reason: ${event.reason || 'No reason provided'})`
        );

        this.connections.delete(connectionId);

        // Handle auto-reconnect
        if (
          connection?.autoReconnect &&
          event.code !== 1000 && // Normal closure
          event.code !== 1001 && // Going away
          connection.reconnectAttempts < connection.maxReconnectAttempts
        ) {
          // Use current URL from connection state (in case it was updated)
          this.scheduleReconnect(connectionId);
        } else {
          state.updateConnectionStatus(connectionId, 'disconnected');
        }
      };

      this.connections.set(connectionId, ws);
    } catch (error) {
      const state = useWebSocketStore.getState();
      state.updateConnectionStatus(connectionId, 'disconnected');
      state.addMessage(
        connectionId,
        'system',
        `Failed to connect: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  disconnect(connectionId: string, clearReconnect = true): void {
    // Clear any pending reconnect
    if (clearReconnect) {
      const timeout = this.reconnectTimeouts.get(connectionId);
      if (timeout) {
        clearTimeout(timeout);
        this.reconnectTimeouts.delete(connectionId);
      }
    }

    // Clear connection timeout
    const connectionTimeout = this.connectionTimeouts.get(connectionId);
    if (connectionTimeout) {
      clearTimeout(connectionTimeout);
      this.connectionTimeouts.delete(connectionId);
    }

    const ws = this.connections.get(connectionId);
    if (ws) {
      ws.onclose = null; // Prevent reconnect on intentional close
      ws.close(1000, 'Client disconnected');
      this.connections.delete(connectionId);

      const state = useWebSocketStore.getState();
      state.updateConnectionStatus(connectionId, 'disconnected');
      state.setReconnectAttempts(connectionId, 0);
    }
  }

  send(connectionId: string, message: string | ArrayBuffer): boolean {
    const ws = this.connections.get(connectionId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(message);

      const state = useWebSocketStore.getState();
      if (message instanceof ArrayBuffer) {
        const hexString = this.arrayBufferToHex(message);
        state.addMessage(connectionId, 'sent', hexString, 'binary', message);
      } else {
        state.addMessage(connectionId, 'sent', message, 'text');
      }
      return true;
    }
    return false;
  }

  getConnection(connectionId: string): WebSocket | undefined {
    return this.connections.get(connectionId);
  }

  isConnected(connectionId: string): boolean {
    const ws = this.connections.get(connectionId);
    return ws?.readyState === WebSocket.OPEN;
  }

  private scheduleReconnect(connectionId: string): void {
    const state = useWebSocketStore.getState();
    const connection = state.connections[connectionId];
    if (!connection) return;

    const attempts = connection.reconnectAttempts + 1;
    state.setReconnectAttempts(connectionId, attempts);
    state.updateConnectionStatus(connectionId, 'reconnecting');

    // Exponential backoff with jitter
    const baseDelay = connection.reconnectDelay;
    const delay = Math.min(
      baseDelay * Math.pow(2, attempts - 1) + Math.random() * 1000,
      30000 // Max 30 seconds
    );

    state.addMessage(
      connectionId,
      'system',
      `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempts}/${connection.maxReconnectAttempts})`
    );

    const timeout = setTimeout(() => {
      this.reconnectTimeouts.delete(connectionId);
      // Get current URL and protocols from store (they may have been updated)
      const currentState = useWebSocketStore.getState();
      const currentConnection = currentState.connections[connectionId];
      if (currentConnection) {
        const protocols = currentConnection.protocols.length > 0 ? currentConnection.protocols : undefined;
        this.connect(connectionId, currentConnection.url, protocols);
      }
    }, delay);

    this.reconnectTimeouts.set(connectionId, timeout);
  }

  private arrayBufferToHex(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ');
  }

  // Convert hex string back to ArrayBuffer for sending binary
  hexToArrayBuffer(hex: string): ArrayBuffer {
    const bytes = hex
      .split(/\s+/)
      .filter((s) => s.length > 0)
      .map((s) => parseInt(s, 16));
    return new Uint8Array(bytes).buffer;
  }

  // Cleanup all connections
  cleanup(): void {
    for (const [connectionId] of this.connections) {
      this.disconnect(connectionId);
    }
  }
}

// Export singleton instance
export const websocketManager = new WebSocketManager();
