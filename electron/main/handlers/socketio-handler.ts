import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { SOCKETIO_RESERVED_EVENTS, socketioChannels } from '@shared/socketio-constants';
import { ipcMain } from 'electron';
// eslint-disable-next-line import/no-duplicates -- namespace + named type imports from 'socket.io-client' can't be merged into a single statement
import type { Socket } from 'socket.io-client';
// eslint-disable-next-line import/no-duplicates -- see above
import type * as SocketIoClient from 'socket.io-client';
import { createLogger } from '../../../src/lib/shared/logger';
import { IPC } from '../../shared/channels';
import { createKeyedRateLimiter } from '../ipc/ipc-rate-limiter';
import { emitTo } from '../ipc/ipc-utils';
import {
  SocketIoConnectSchema,
  SocketIoEmitSchema,
  SocketIoDisconnectSchema,
  validateIpcInput,
  createValidatedHandler,
  assertTrustedSender,
} from '../ipc/ipc-validators';
import { StreamRegistry } from '../ipc/stream-registry';
import { resolveSafeAddress, createPinnedLookup } from '../security/safe-connect';

const log = createLogger('socketio');

export const socketIoRateLimiter = createKeyedRateLimiter(20, 60_000);

// socket.io-client is loaded lazily on first connect so it doesn't evaluate at
// app boot (the static import ran before app.whenReady via main.ts). The connect
// handler is async, so a dynamic import() is fine here — and it keeps module
// mocking working in the DNS-pinning regression tests. Memoized.
//
// The cast pins the runtime import to the CJS module shape: under nodenext this
// file is CJS, so `import type { Socket }` above resolves the CJS build, while a
// bare `await import()` resolves the ESM build — TS treats the two `io` types as
// distinct. Casting unifies them with the rest of the file.
type SocketIoModule = typeof SocketIoClient;
let _io: SocketIoModule['io'] | undefined;
const getIo = async (): Promise<SocketIoModule['io']> =>
  (_io ??= ((await import('socket.io-client')) as unknown as SocketIoModule).io);

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
  /** Pinned-DNS agent backing every transport for this connection; destroyed on teardown. */
  agent: HttpAgent | HttpsAgent;
}

/** Tear down a connection's transport + timers + pinned agent. */
function disposeSocketIo(entry: ActiveSocketIO): void {
  entry.explicitlyClosed = true;
  for (const t of entry.pendingAcks.values()) clearTimeout(t);
  entry.pendingAcks.clear();
  try {
    entry.socket.disconnect();
  } catch {
    /* ignore */
  }
  try {
    entry.agent.destroy();
  } catch {
    /* ignore */
  }
}

// Shared connection bookkeeping (map + same-id replace + renderer-destroyed
// cleanup + disposeAll), with disposeSocketIo as the dispose seam. Socket.IO
// keeps direct emitTo with `socketioChannels` (its channel names are builder
// functions, not the eventChannel(prefix,id) shape registry.emit uses), so the
// registry is used purely for bookkeeping here.
const activeConnections = new StreamRegistry<ActiveSocketIO>({ dispose: disposeSocketIo });

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
  ipcMain.handle(IPC.socketio.connect, async (event, rawConfig: unknown) => {
    assertTrustedSender(IPC.socketio.connect, event);
    const config = validateIpcInput(SocketIoConnectSchema, rawConfig, IPC.socketio.connect);
    const connectionId = config.connectionId;
    const webContentsId = event.sender.id;

    if (!socketIoRateLimiter.check(webContentsId)) {
      return { success: false, error: 'Rate limit exceeded. Please wait before connecting.' };
    }

    if (activeConnections.size() >= MAX_CONCURRENT_SOCKETIO_CONNECTIONS) {
      return { success: false, error: 'Too many open Socket.IO connections.' };
    }

    // Close an existing connection with the same id (dispose tears it down).
    activeConnections.cancel(connectionId);

    // Resolve + validate once, then PIN every transport to that IP. socket.io
    // re-resolves DNS on connect (and on each reconnect), so a one-shot
    // pre-flight check leaves a rebind/TOCTOU window open — matching the WS and
    // gRPC handlers, we close it. engine.io-client forwards `agent` to both the
    // `ws` (websocket) and `xmlhttprequest-ssl` (polling) transports, so a single
    // agent carrying a pinned `lookup` covers both. The URL keeps the original
    // hostname so SNI + Host header stay correct.
    let pinned: Awaited<ReturnType<typeof resolveSafeAddress>>;
    try {
      pinned = await resolveSafeAddress(config.url, {
        allowLocalhost: true,
        allowedSchemes: ['http:', 'https:', 'ws:', 'wss:'],
      });
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'URL rejected by SSRF policy',
      };
    }

    try {
      const connectUrl = buildConnectUrl(config.url, config.namespace);
      const secure = /^(https|wss):/i.test(config.url);
      const lookup = createPinnedLookup(pinned.host, pinned.ip);
      const agent = secure ? new HttpsAgent({ lookup }) : new HttpAgent({ lookup });

      const socket = (await getIo())(connectUrl, {
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
        // engine.io types `agent` as string|boolean for historical reasons, but
        // at runtime it forwards the value straight to ws / http(s).request,
        // both of which accept an http(s).Agent. Cast at the boundary.
        agent: agent as unknown as boolean,
      });

      const entry: ActiveSocketIO = {
        socket,
        connectionId,
        url: connectUrl,
        createdAt: Date.now(),
        webContentsId,
        explicitlyClosed: false,
        pendingAcks: new Map(),
        agent,
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
        log.warn('connect error', { connectionId, error: err.message });
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

      // add() stores the entry and wires renderer-destroyed cleanup (dispose
      // tears the transport/timers/agent down).
      activeConnections.add(connectionId, event.sender, entry);

      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to connect';
      log.warn('connect failed', { connectionId, error: message });
      return {
        success: false,
        error: message,
      };
    }
  });

  ipcMain.handle(
    IPC.socketio.emit,
    createValidatedHandler(IPC.socketio.emit, SocketIoEmitSchema, async (config) => {
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
    IPC.socketio.disconnect,
    createValidatedHandler(IPC.socketio.disconnect, SocketIoDisconnectSchema, async (config) => {
      activeConnections.cancel(config.connectionId);
      return { success: true };
    })
  );
}

export function stopSocketIoCleanup(): void {
  activeConnections.disposeAll();
}
