import { ipcMain, BrowserWindow } from 'electron';
import WebSocket from 'ws';
import { createRateLimiter } from './ipc-rate-limiter';

const wsRateLimiter = createRateLimiter(20, 60_000);

interface ActiveWebSocket {
  ws: WebSocket;
  connectionId: string;
  url: string;
  createdAt: number;
}

const activeConnections = new Map<string, ActiveWebSocket>();

// Maximum message size (1MB)
const MAX_MESSAGE_SIZE = 1024 * 1024;

function getWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows();
  return windows[0] ?? null;
}

function sanitizeConnectionId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
}

function emit(channel: string, ...args: unknown[]): void {
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, ...args);
  }
}

export function registerWebSocketHandlerIPC(): void {
  // Connect to a WebSocket server with custom headers
  ipcMain.handle('ws:connect', async (_event, config: {
    connectionId: string;
    url: string;
    headers?: Record<string, string>;
    protocols?: string[];
  }) => {
    const connectionId = sanitizeConnectionId(config.connectionId);

    if (!wsRateLimiter()) {
      return { success: false, error: 'Rate limit exceeded. Please wait before connecting.' };
    }

    // Close existing connection with same id
    const existing = activeConnections.get(connectionId);
    if (existing) {
      existing.ws.terminate();
      activeConnections.delete(connectionId);
    }

    try {
      const ws = new WebSocket(config.url, config.protocols ?? [], {
        headers: config.headers ?? {},
        maxPayload: MAX_MESSAGE_SIZE,
        followRedirects: true,
        handshakeTimeout: 30000,
      });

      const entry: ActiveWebSocket = {
        ws,
        connectionId,
        url: config.url,
        createdAt: Date.now(),
      };

      ws.on('open', () => {
        emit(`ws:open:${connectionId}`);
      });

      ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        if (isBinary) {
          const hex = Buffer.isBuffer(data) ? data.toString('hex') : Buffer.from(data as ArrayBuffer).toString('hex');
          emit(`ws:message:${connectionId}`, { type: 'binary', data: hex });
        } else {
          emit(`ws:message:${connectionId}`, { type: 'text', data: data.toString() });
        }
      });

      ws.on('error', (err: Error) => {
        emit(`ws:error:${connectionId}`, { message: err.message });
      });

      ws.on('close', (code: number, reason: Buffer) => {
        activeConnections.delete(connectionId);
        emit(`ws:close:${connectionId}`, { code, reason: reason.toString() });
      });

      activeConnections.set(connectionId, entry);
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to connect',
      };
    }
  });

  // Send a text or binary message
  ipcMain.handle('ws:send', async (_event, config: {
    connectionId: string;
    message: string;
    binary?: boolean;
  }) => {
    const connectionId = sanitizeConnectionId(config.connectionId);
    const entry = activeConnections.get(connectionId);

    if (!entry || entry.ws.readyState !== WebSocket.OPEN) {
      return { success: false, error: 'Not connected' };
    }

    try {
      if (config.binary) {
        const buf = Buffer.from(config.message, 'hex');
        entry.ws.send(buf);
      } else {
        entry.ws.send(config.message);
      }
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Send failed',
      };
    }
  });

  // Disconnect
  ipcMain.handle('ws:disconnect', async (_event, config: { connectionId: string }) => {
    const connectionId = sanitizeConnectionId(config.connectionId);
    const entry = activeConnections.get(connectionId);
    if (entry) {
      entry.ws.close(1000, 'Client disconnected');
      activeConnections.delete(connectionId);
    }
    return { success: true };
  });
}

export function stopWebSocketCleanup(): void {
  for (const [, entry] of activeConnections) {
    try { entry.ws.terminate(); } catch { /* ignore */ }
  }
  activeConnections.clear();
}
