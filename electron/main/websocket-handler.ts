import { ipcMain, webContents } from 'electron';
import WebSocket from 'ws';
import { createRateLimiter } from './ipc-rate-limiter';
import {
  WsConnectSchema,
  WsSendSchema,
  WsDisconnectSchema,
  validateIpcInput,
  createValidatedHandler,
} from './ipc-validators';

const wsRateLimiter = createRateLimiter(20, 60_000);

const MAX_CONCURRENT_WS_CONNECTIONS = 50;

interface ActiveWebSocket {
  ws: WebSocket;
  connectionId: string;
  url: string;
  createdAt: number;
  /** webContents ID of the renderer that opened this connection — used for targeted IPC emission */
  webContentsId: number;
  setExplicitlyClosed?: () => void;
}

const activeConnections = new Map<string, ActiveWebSocket>();

// Maximum message size (1MB)
const MAX_MESSAGE_SIZE = 1024 * 1024;

function emitTo(webContentsId: number, channel: string, ...args: unknown[]): void {
  const wc = webContents.fromId(webContentsId);
  if (wc && !wc.isDestroyed()) {
    wc.send(channel, ...args);
  }
}

export function registerWebSocketHandlerIPC(): void {
  // ws:connect is handled manually (not via createValidatedHandler) so we can capture
  // event.sender.id and target IPC emissions to the originating renderer window.
  ipcMain.handle('ws:connect', async (event, rawConfig: unknown) => {
    const config = validateIpcInput(WsConnectSchema, rawConfig, 'ws:connect');
    const connectionId = config.connectionId;
    const webContentsId = event.sender.id;

    if (!wsRateLimiter()) {
      return { success: false, error: 'Rate limit exceeded. Please wait before connecting.' };
    }

    if (activeConnections.size >= MAX_CONCURRENT_WS_CONNECTIONS) {
      return { success: false, error: 'Too many open connections.' };
    }

    // Close existing connection with same id
    const existing = activeConnections.get(connectionId);
    if (existing) {
      existing.ws.terminate();
      activeConnections.delete(connectionId);
    }

    try {
      let explicitlyClosed = false;

      const ws = new WebSocket(config.url, config.protocols ?? [], {
        headers: config.headers ?? {},
        maxPayload: MAX_MESSAGE_SIZE,
        followRedirects: true,
        handshakeTimeout: 30000,
      });

      // NOTE: success is returned immediately (handshake in progress).
      // The renderer should wait for the ws:open:<connectionId> event before sending messages.
      const entry: ActiveWebSocket = {
        ws,
        connectionId,
        url: config.url,
        createdAt: Date.now(),
        webContentsId,
      };

      ws.on('open', () => {
        emitTo(webContentsId, `ws:open:${connectionId}`);
      });

      ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        if (isBinary) {
          // Binary frames are encoded as base64 for IPC transport
          const b64 = Buffer.isBuffer(data)
            ? data.toString('base64')
            : Buffer.from(data as ArrayBuffer).toString('base64');
          emitTo(webContentsId, `ws:message:${connectionId}`, { type: 'binary', data: b64 });
        } else {
          emitTo(webContentsId, `ws:message:${connectionId}`, { type: 'text', data: data.toString() });
        }
      });

      ws.on('error', (err: Error) => {
        emitTo(webContentsId, `ws:error:${connectionId}`, { message: err.message });
      });

      ws.on('close', (code: number, reason: Buffer) => {
        activeConnections.delete(connectionId);
        // Only forward unexpected closes; explicit ws:disconnect is already acked to the renderer
        if (!explicitlyClosed) {
          emitTo(webContentsId, `ws:close:${connectionId}`, { code, reason: reason.toString() });
        }
      });

      entry.setExplicitlyClosed = () => { explicitlyClosed = true; };
      activeConnections.set(connectionId, entry);
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to connect',
      };
    }
  });

  ipcMain.handle(
    'ws:send',
    createValidatedHandler('ws:send', WsSendSchema, async (config) => {
      const connectionId = config.connectionId;
      const entry = activeConnections.get(connectionId);

      if (!entry || entry.ws.readyState !== WebSocket.OPEN) {
        return { success: false, error: 'Not connected' };
      }

      try {
        if (config.binary) {
          // Binary messages arrive from renderer as base64 (matching the receive encoding)
          const buf = Buffer.from(config.message, 'base64');
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
    })
  );

  ipcMain.handle(
    'ws:disconnect',
    createValidatedHandler('ws:disconnect', WsDisconnectSchema, async (config) => {
      const connectionId = config.connectionId;
      const entry = activeConnections.get(connectionId);
      if (entry) {
        entry.setExplicitlyClosed?.();
        entry.ws.close(1000, 'Client disconnected');
        activeConnections.delete(connectionId);
      }
      return { success: true };
    })
  );
}

export function stopWebSocketCleanup(): void {
  for (const [, entry] of activeConnections) {
    try { entry.ws.terminate(); } catch { /* ignore */ }
  }
  activeConnections.clear();
}
