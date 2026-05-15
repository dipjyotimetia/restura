import { ipcMain } from 'electron';
import { io as ioClient, type Socket } from 'socket.io-client';
import { createKeyedRateLimiter } from './ipc-rate-limiter';
import { emitTo } from './ipc-utils';
import {
  SocketIoConnectSchema,
  SocketIoEmitSchema,
  SocketIoDisconnectSchema,
  validateIpcInput,
  createValidatedHandler,
} from './ipc-validators';
import { SOCKETIO_RESERVED_EVENTS, socketioChannels } from '@shared/socketio-constants';

export const socketIoRateLimiter = createKeyedRateLimiter(20, 60_000);

const MAX_CONCURRENT_SOCKETIO_CONNECTIONS = 50;
const DEFAULT_ACK_TIMEOUT_MS = 15_000;

interface ActiveSocketIO {
  socket: Socket;
  connectionId: string;
  url: string;
  createdAt: number;
  /** webContents ID of the renderer that opened this connection */
  webContentsId: number;
  explicitlyClosed: boolean;
  pendingAcks: Map<string, NodeJS.Timeout>;
}

const activeConnections = new Map<string, ActiveSocketIO>();

function buildConnectUrl(rawUrl: string, namespace: string | undefined): string {
  // Socket.IO joins the namespace by appending it to the URL's pathname.
  // The io() client accepts either url + { path } or url-with-namespace-suffix.
  // We append namespace here so the wire URL exactly matches user intent.
  if (!namespace || namespace === '/' || namespace === '') return rawUrl;
  try {
    const u = new URL(rawUrl);
    // Strip trailing slash on origin, then append namespace path.
    const origin = `${u.protocol}//${u.host}`;
    const ns = namespace.startsWith('/') ? namespace : `/${namespace}`;
    return `${origin}${ns}`;
  } catch {
    return rawUrl;
  }
}

export function registerSocketIoHandlerIPC(): void {
  // socketio:connect is handled manually so we can capture event.sender.id
  // and target IPC emissions to the originating renderer window.
  ipcMain.handle('socketio:connect', async (event, rawConfig: unknown) => {
    const config = validateIpcInput(SocketIoConnectSchema, rawConfig, 'socketio:connect');
    const connectionId = config.connectionId;
    const webContentsId = event.sender.id;

    if (!socketIoRateLimiter.check(webContentsId)) {
      return { success: false, error: 'Rate limit exceeded. Please wait before connecting.' };
    }

    if (activeConnections.size >= MAX_CONCURRENT_SOCKETIO_CONNECTIONS) {
      return { success: false, error: 'Too many open Socket.IO connections.' };
    }

    // Close existing connection with the same id
    const existing = activeConnections.get(connectionId);
    if (existing) {
      existing.explicitlyClosed = true;
      for (const t of existing.pendingAcks.values()) clearTimeout(t);
      existing.pendingAcks.clear();
      try { existing.socket.disconnect(); } catch { /* ignore */ }
      activeConnections.delete(connectionId);
    }

    try {
      const connectUrl = buildConnectUrl(config.url, config.namespace);

      const socket = ioClient(connectUrl, {
        path: config.path ?? '/socket.io',
        auth: config.auth ?? {},
        query: config.query ?? {},
        extraHeaders: config.extraHeaders ?? {},
        transports: config.transports ?? ['websocket', 'polling'],
        reconnection: config.reconnection ?? true,
        reconnectionAttempts: config.reconnectionAttempts ?? 5,
        reconnectionDelay: config.reconnectionDelay ?? 1_000,
        timeout: config.timeout ?? 20_000,
        forceNew: config.forceNew ?? false,
        autoConnect: true,
      });

      const entry: ActiveSocketIO = {
        socket,
        connectionId,
        url: connectUrl,
        createdAt: Date.now(),
        webContentsId,
        explicitlyClosed: false,
        pendingAcks: new Map(),
      };

      socket.on('connect', () => {
        emitTo(webContentsId, socketioChannels.open(connectionId), { socketId: socket.id });
      });

      socket.on('disconnect', (reason: string) => {
        if (!entry.explicitlyClosed) {
          emitTo(webContentsId, socketioChannels.close(connectionId), { reason });
        }
      });

      socket.on('connect_error', (err: Error) => {
        emitTo(webContentsId, socketioChannels.error(connectionId), { message: err.message });
      });

      const manager = socket.io;
      manager.on('reconnect_attempt', (attempt: number) => {
        emitTo(webContentsId, socketioChannels.reconnectAttempt(connectionId), { attempt });
      });
      manager.on('reconnect', (attempt: number) => {
        emitTo(webContentsId, socketioChannels.reconnect(connectionId), { attempt });
      });
      manager.on('reconnect_failed', () => {
        emitTo(webContentsId, socketioChannels.reconnectFailed(connectionId));
      });

      // Forwards application events; lifecycle events above already cover SOCKETIO_RESERVED_EVENTS.
      socket.onAny((eventName: string, ...args: unknown[]) => {
        if (SOCKETIO_RESERVED_EVENTS.has(eventName)) return;
        emitTo(webContentsId, socketioChannels.event(connectionId), { eventName, args });
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

  ipcMain.handle(
    'socketio:emit',
    createValidatedHandler('socketio:emit', SocketIoEmitSchema, async (config) => {
      const entry = activeConnections.get(config.connectionId);
      if (!entry) {
        return { success: false, error: 'Not connected' };
      }
      if (!entry.socket.connected) {
        return { success: false, error: 'Socket is not currently connected' };
      }

      try {
        if (config.ackId) {
          const ackId = config.ackId;
          const timeoutMs = config.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
          const webContentsId = entry.webContentsId;

          const timeoutHandle = setTimeout(() => {
            entry.pendingAcks.delete(ackId);
            emitTo(webContentsId, socketioChannels.ack(entry.connectionId), {
              ackId,
              error: 'timeout',
            });
          }, timeoutMs);
          entry.pendingAcks.set(ackId, timeoutHandle);

          entry.socket.emit(config.eventName, ...config.args, (...ackArgs: unknown[]) => {
            const handle = entry.pendingAcks.get(ackId);
            if (handle === undefined) return; // already timed out
            clearTimeout(handle);
            entry.pendingAcks.delete(ackId);
            emitTo(webContentsId, socketioChannels.ack(entry.connectionId), {
              ackId,
              args: ackArgs,
            });
          });
        } else {
          entry.socket.emit(config.eventName, ...config.args);
        }
        return { success: true };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Emit failed',
        };
      }
    })
  );

  ipcMain.handle(
    'socketio:disconnect',
    createValidatedHandler('socketio:disconnect', SocketIoDisconnectSchema, async (config) => {
      const entry = activeConnections.get(config.connectionId);
      if (entry) {
        entry.explicitlyClosed = true;
        for (const t of entry.pendingAcks.values()) clearTimeout(t);
        entry.pendingAcks.clear();
        try { entry.socket.disconnect(); } catch { /* ignore */ }
        activeConnections.delete(config.connectionId);
      }
      return { success: true };
    })
  );
}

export function stopSocketIoCleanup(): void {
  for (const [, entry] of activeConnections) {
    try {
      entry.explicitlyClosed = true;
      for (const t of entry.pendingAcks.values()) clearTimeout(t);
      entry.pendingAcks.clear();
      entry.socket.disconnect();
    } catch { /* ignore */ }
  }
  activeConnections.clear();
}
