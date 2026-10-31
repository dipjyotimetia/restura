import { randomUUID } from 'node:crypto';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { createLogger } from '@shared/runtime/logger';
import { SOCKETIO_RESERVED_EVENTS, socketioChannels } from '@shared/socketio-constants';
import { prepareIncomingArgs, SOCKETIO_MAX_INCOMING_BYTES } from '@shared/socketio-payload';
import { ipcMain } from 'electron';
import type * as SocketIoClient from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { IPC } from '../../shared/channels';
import { createKeyedRateLimiter } from '../ipc/ipc-rate-limiter';
import { emitTo } from '../ipc/ipc-utils';
import {
  assertTrustedSender,
  createValidatedEventHandler,
  SocketIoConnectSchema,
  SocketIoDisconnectSchema,
  SocketIoEmitSchema,
  SocketIoReplyAckSchema,
  validateIpcInput,
} from '../ipc/ipc-validators';
import { StreamRegistry } from '../ipc/stream-registry';
import { getExecutionPolicy } from '../security/execution-policy';
import {
  assertPinnedFetchCanHonorPolicy,
  type PolicyTransportConfig,
  resolvePolicyTransport,
} from '../security/policy-transport';
import { createPinnedLookup, resolveSafeAddress } from '../security/safe-connect';

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
/** Unanswered server-requested acks kept per connection; oldest dropped beyond this. */
const MAX_PENDING_SERVER_ACKS = 500;

function resolveSocketIoExecutionPolicy<T extends PolicyTransportConfig>(config: T) {
  return resolvePolicyTransport(config);
}

interface ActiveSocketIO {
  socket: Socket;
  connectionId: string;
  url: string;
  createdAt: number;
  /** webContents ID of the renderer that opened this connection */
  webContentsId: number;
  explicitlyClosed: boolean;
  pendingAcks: Map<string, NodeJS.Timeout>;
  /** Server-requested ack callbacks awaiting the user's reply, keyed by serverAckId. */
  serverAcks: Map<string, (...args: unknown[]) => void>;
  /** Pinned-DNS agent backing every transport for this connection; destroyed on teardown. */
  agent: HttpAgent | HttpsAgent;
}

/** Tear down a connection's transport + timers + pinned agent. */
function disposeSocketIo(entry: ActiveSocketIO): void {
  entry.explicitlyClosed = true;
  for (const t of entry.pendingAcks.values()) clearTimeout(t);
  entry.pendingAcks.clear();
  entry.serverAcks.clear();
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

    let policyConfig: ReturnType<typeof resolveSocketIoExecutionPolicy>;
    try {
      policyConfig = resolveSocketIoExecutionPolicy({
        url: config.url,
        timeout: config.timeout,
      });
      assertPinnedFetchCanHonorPolicy(policyConfig);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Connection policy rejected',
      };
    }

    if (!socketIoRateLimiter.check(webContentsId)) {
      return { success: false, error: 'Rate limit exceeded. Please wait before connecting.' };
    }

    if (
      activeConnections.size() + activeConnections.pendingCount() >=
      MAX_CONCURRENT_SOCKETIO_CONNECTIONS
    ) {
      return { success: false, error: 'Too many open Socket.IO connections.' };
    }

    // Reserve this renderer's id synchronously before DNS or transport
    // construction. Another renderer may independently use the same external id.
    const claim = activeConnections.reserveClaim(connectionId, event.sender);
    if (!claim) return { success: false, error: 'Not connected' };

    try {
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
          ...getExecutionPolicy().security,
          allowedSchemes: ['http:', 'https:', 'ws:', 'wss:'],
        });
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'URL rejected by SSRF policy',
        };
      }

      // Renderer destruction/module teardown may invalidate the reservation
      // while DNS is pending. Never load/start a transport for a stale claim.
      if (!activeConnections.isClaimLive(claim)) {
        return { success: false, error: 'Not connected' };
      }

      try {
        const connectUrl = buildConnectUrl(config.url, config.namespace);
        const secure = /^(https|wss):/i.test(config.url);
        const lookup = createPinnedLookup(pinned.host, pinned.ip);
        const io = await getIo();
        if (!activeConnections.isClaimLive(claim)) {
          return { success: false, error: 'Not connected' };
        }
        const agent = secure ? new HttpsAgent({ lookup }) : new HttpAgent({ lookup });

        const socket = io(connectUrl, {
          path: config.path ?? '/socket.io',
          auth: config.auth ?? {},
          query: config.query ?? {},
          extraHeaders: config.extraHeaders ?? {},
          transports: config.transports ?? ['websocket', 'polling'],
          reconnection: config.reconnection ?? true,
          reconnectionAttempts: config.reconnectionAttempts ?? 5,
          reconnectionDelay: config.reconnectionDelay ?? 1_000,
          reconnectionDelayMax: config.reconnectionDelayMax ?? 5_000,
          randomizationFactor: config.randomizationFactor ?? 0.5,
          timeout: policyConfig.timeout,
          rejectUnauthorized: policyConfig.verifySsl,
          forceNew: config.forceNew ?? false,
          autoConnect: true,
          // Cap inbound websocket frames like the WebSocket handler (an
          // oversize frame closes the transport). Polling has no transport cap;
          // prepareIncomingArgs drops oversize events before IPC.
          transportOptions: { websocket: { maxPayload: SOCKETIO_MAX_INCOMING_BYTES } },
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
          serverAcks: new Map(),
          agent,
        };

        socket.on('connect', () => {
          if (activeConnections.get(connectionId, webContentsId) !== entry) return;
          emitTo(webContentsId, socketioChannels.open(connectionId), { socketId: socket.id });
        });

        socket.on('disconnect', (reason: string) => {
          if (activeConnections.get(connectionId, webContentsId) !== entry) return;
          if (!entry.explicitlyClosed) {
            emitTo(webContentsId, socketioChannels.close(connectionId), { reason });
          }
        });

        socket.on('connect_error', (err: Error) => {
          if (activeConnections.get(connectionId, webContentsId) !== entry) return;
          log.warn('connect error', { connectionId, error: err.message });
          emitTo(webContentsId, socketioChannels.error(connectionId), { message: err.message });
        });

        const manager = socket.io;
        manager.on('reconnect_attempt', (attempt: number) => {
          if (activeConnections.get(connectionId, webContentsId) !== entry) return;
          emitTo(webContentsId, socketioChannels.reconnectAttempt(connectionId), { attempt });
        });
        manager.on('reconnect', (attempt: number) => {
          if (activeConnections.get(connectionId, webContentsId) !== entry) return;
          emitTo(webContentsId, socketioChannels.reconnect(connectionId), { attempt });
        });
        manager.on('reconnect_failed', () => {
          if (activeConnections.get(connectionId, webContentsId) !== entry) return;
          emitTo(webContentsId, socketioChannels.reconnectFailed(connectionId));
        });

        // Forwards application events; lifecycle events above already cover
        // SOCKETIO_RESERVED_EVENTS. A server-requested ack callback is kept
        // here (functions can't cross IPC) and answered via replyAck.
        socket.onAny((eventName: string, ...rawArgs: unknown[]) => {
          if (activeConnections.get(connectionId, webContentsId) !== entry) return;
          if (SOCKETIO_RESERVED_EVENTS.has(eventName)) return;
          const { args, ack, oversizeBytes } = prepareIncomingArgs(rawArgs);
          if (oversizeBytes !== undefined) {
            log.warn('oversize event dropped', { connectionId, eventName, bytes: oversizeBytes });
          }
          let serverAckId: string | undefined;
          if (ack) {
            serverAckId = randomUUID();
            entry.serverAcks.set(serverAckId, ack);
            if (entry.serverAcks.size > MAX_PENDING_SERVER_ACKS) {
              const oldest = entry.serverAcks.keys().next().value;
              if (oldest !== undefined) entry.serverAcks.delete(oldest);
            }
          }
          emitTo(webContentsId, socketioChannels.event(connectionId), {
            eventName,
            args,
            ...(serverAckId ? { serverAckId } : {}),
          });
        });

        // Commit only the exact live reservation. For reconnects, also require
        // the original owner entry to still be current so stale work cannot
        // replace a newer connection.
        if (!activeConnections.commitClaim(claim, event.sender, entry)) {
          disposeSocketIo(entry);
          return { success: false, error: 'Not connected' };
        }

        return { success: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to connect';
        log.warn('connect failed', { connectionId, error: message });
        return {
          success: false,
          error: message,
        };
      }
    } finally {
      activeConnections.releaseClaim(claim);
    }
  });

  ipcMain.handle(
    IPC.socketio.emit,
    createValidatedEventHandler(IPC.socketio.emit, SocketIoEmitSchema, async (config, event) => {
      const entry = activeConnections.getForOwner(config.connectionId, event.sender.id);
      if (!entry) {
        return { success: false, error: 'Not connected' };
      }
      if (!entry.socket.connected) {
        return { success: false, error: 'Socket is not currently connected' };
      }

      try {
        // Per-emit modifiers (SIO-5). Both return the socket with a one-shot flag set.
        let emitter: Socket = entry.socket;
        if (config.volatile) emitter = emitter.volatile;
        if (config.compress === false) emitter = emitter.compress(false);
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

          emitter.emit(config.eventName, ...config.args, (...ackArgs: unknown[]) => {
            const handle = entry.pendingAcks.get(ackId);
            if (handle === undefined) return; // already timed out
            clearTimeout(handle);
            entry.pendingAcks.delete(ackId);
            emitTo(webContentsId, socketioChannels.ack(entry.connectionId), {
              ackId,
              args: prepareIncomingArgs(ackArgs).args,
            });
          });
        } else {
          emitter.emit(config.eventName, ...config.args);
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
    IPC.socketio.replyAck,
    createValidatedEventHandler(
      IPC.socketio.replyAck,
      SocketIoReplyAckSchema,
      async (config, event) => {
        const entry = activeConnections.getForOwner(config.connectionId, event.sender.id);
        if (!entry) return { success: false, error: 'Not connected' };
        const ack = entry.serverAcks.get(config.serverAckId);
        if (!ack) {
          return { success: false, error: 'Acknowledgement already answered or expired' };
        }
        entry.serverAcks.delete(config.serverAckId);
        try {
          ack(...config.args);
          return { success: true };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Ack reply failed',
          };
        }
      }
    )
  );

  ipcMain.handle(
    IPC.socketio.disconnect,
    createValidatedEventHandler(
      IPC.socketio.disconnect,
      SocketIoDisconnectSchema,
      async (config, event) => {
        activeConnections.cancelForOwner(config.connectionId, event.sender.id);
        return { success: true };
      }
    )
  );
}

export function stopSocketIoCleanup(): void {
  activeConnections.clearClaims();
  activeConnections.disposeAll();
}
