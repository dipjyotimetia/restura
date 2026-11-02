import { SOCKETIO_RESERVED_EVENTS, socketioChannels } from '@shared/socketio-constants';
import { encodeBinaryArgs, prepareIncomingArgs } from '@shared/socketio-payload';
import { io as ioClient, type Socket } from 'socket.io-client';
import { v4 as uuidv4 } from 'uuid';
import { buildSocketIOConnectUrl, validateSocketIOUrl } from '@/features/socketio/lib/url-helpers';
import {
  DEFAULT_ACK_TIMEOUT_MS,
  SOCKETIO_CONNECTION_OPTION_DEFAULTS,
  type SocketIOEmitOptions,
  type SocketIOTransport,
  useSocketIOStore,
} from '@/features/socketio/store/useSocketIOStore';
import { checkBrowserSocketTargetFromSettings } from '@/lib/shared/browserSocketPolicy';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import { keyValuePairsToRecord } from '@/lib/shared/utils';

interface ConnectConfig {
  url: string;
  namespace: string;
  path: string;
  auth: Record<string, unknown>;
  query: Record<string, string>;
  extraHeaders: Record<string, string>;
  transports: SocketIOTransport[];
  reconnection: boolean;
  reconnectionAttempts: number;
  reconnectionDelay: number;
  reconnectionDelayMax: number;
  randomizationFactor: number;
  timeout: number;
  forceNew: boolean;
}

/** Values resolved by the caller (`connectWithVariables`) that must not be written back to the store. */
export interface ConnectOverrides {
  url?: string;
  auth?: Record<string, unknown>;
}

export type ParsedAuthJson =
  | { ok: true; auth: Record<string, unknown> }
  | { ok: false; error: string };

/** Parse handshake auth JSON (SIO-4). Socket.IO requires a plain object. */
export function parseAuthJson(text: string): ParsedAuthJson {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, auth: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Invalid JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Auth payload must be a JSON object' };
  }
  return { ok: true, auth: parsed as Record<string, unknown> };
}

/** Unanswered server-requested acks kept per connection; oldest dropped beyond this. */
const MAX_PENDING_SERVER_ACKS = 500;

interface PendingAck {
  resolve: (args: unknown[]) => void;
  timer: ReturnType<typeof setTimeout>;
}

class SocketIOManager {
  private browserSockets = new Map<string, Socket>();
  private electronConnections = new Set<string>();
  private subscriptions = new Map<string, Set<string>>(); // connectionId → eventNames
  private browserAcks = new Map<string, Map<string, PendingAck>>(); // connectionId → ackId → pending
  // connectionId → serverAckId → server-requested ack callback (web only; desktop keeps them in main)
  private browserServerAcks = new Map<string, Map<string, (...args: unknown[]) => void>>();
  // serverAckIds with a desktop reply-ack IPC in flight — a double click must not send twice.
  private inFlightServerAckReplies = new Set<string>();

  /**
   * `overrides` carries the `{{var}}`-resolved URL / auth for this live
   * connection only — they are never written back to the persisted store
   * (SIO-2).
   */
  connect(connectionId: string, overrides: ConnectOverrides = {}): void {
    const store = useSocketIOStore.getState();
    const connection = store.connections[connectionId];
    if (!connection) return;

    this.disconnect(connectionId);

    const fail = (message: string) => {
      store.addEvent(connectionId, {
        direction: 'system',
        eventName: '<system>',
        args: [`Connection failed: ${message}`],
      });
      store.updateConnectionStatus(connectionId, 'disconnected');
    };

    const url = overrides.url ?? connection.url;
    const v = validateSocketIOUrl(url);
    if (!v.valid) {
      fail(v.error ?? 'Invalid URL');
      return;
    }

    let auth: Record<string, unknown>;
    if (overrides.auth) {
      auth = overrides.auth;
    } else if (connection.authMode === 'json') {
      const parsed = parseAuthJson(connection.authJson ?? '');
      if (!parsed.ok) {
        fail(`Invalid auth JSON: ${parsed.error}`);
        return;
      }
      auth = parsed.auth;
    } else {
      auth = keyValuePairsToRecord(connection.auth);
    }

    const d = SOCKETIO_CONNECTION_OPTION_DEFAULTS;
    const config: ConnectConfig = {
      url,
      namespace: connection.namespace || '/',
      path: connection.path || '/socket.io',
      auth,
      query: keyValuePairsToRecord(connection.query),
      extraHeaders: keyValuePairsToRecord(connection.extraHeaders),
      transports:
        connection.transports.length > 0 ? connection.transports : ['websocket', 'polling'],
      reconnection: connection.autoReconnect,
      reconnectionAttempts: connection.reconnectionAttempts,
      reconnectionDelay: connection.reconnectionDelay,
      reconnectionDelayMax: connection.reconnectionDelayMax ?? d.reconnectionDelayMax,
      randomizationFactor: connection.randomizationFactor ?? d.randomizationFactor,
      timeout: connection.timeout,
      forceNew: connection.forceNew,
    };

    store.updateConnectionStatus(connectionId, 'connecting');
    store.setReconnectAttemptCount(connectionId, 0);

    if (isElectron()) {
      this.connectViaElectron(connectionId, config);
    } else {
      // Browser path: warn if extraHeaders are set (silently ignored by browser WebSocket transport)
      if (
        Object.keys(config.extraHeaders).length > 0 &&
        !config.transports.every((t) => t === 'polling')
      ) {
        store.addEvent(connectionId, {
          direction: 'system',
          eventName: '<system>',
          args: [
            'Custom headers are ignored on the WebSocket transport in browsers. Force "polling" transport (or use the desktop app) to send extraHeaders to the server.',
          ],
        });
      }
      this.connectViaBrowser(connectionId, config);
    }
  }

  /**
   * `display` overrides the transcript copy of the emit — used to keep
   * resolved secret `{{var}}` values out of the event log (#974).
   */
  emit(
    connectionId: string,
    eventName: string,
    args: unknown[],
    withAck = false,
    display?: { eventName: string; args: unknown[] },
    options: Partial<SocketIOEmitOptions> = {}
  ): void {
    const store = useSocketIOStore.getState();
    // Binary args (Uint8Array) are logged as `{ $binary }` markers.
    const logged = display ?? { eventName, args: encodeBinaryArgs(args) };
    const ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;

    if (this.electronConnections.has(connectionId)) {
      const api = getElectronAPI();
      if (!api?.socketio) return;
      const ackId = withAck ? uuidv4() : undefined;
      store.addEvent(connectionId, {
        direction: 'sent',
        ...logged,
        ...(ackId ? { ackId } : {}),
      });
      void api.socketio.emit({
        connectionId,
        eventName,
        args,
        ...(ackId ? { ackId, ackTimeoutMs } : {}),
        ...(options.volatile ? { volatile: true } : {}),
        ...(options.compress === false ? { compress: false } : {}),
      });
      return;
    }

    const socket = this.browserSockets.get(connectionId);
    if (!socket?.connected) {
      store.addEvent(connectionId, {
        direction: 'system',
        eventName: '<system>',
        args: ['Cannot emit: socket is not connected'],
      });
      return;
    }

    // Per-emit modifiers (SIO-5). Both return the socket with a one-shot flag set.
    let emitter: Socket = socket;
    if (options.volatile) emitter = emitter.volatile;
    if (options.compress === false) emitter = emitter.compress(false);

    if (withAck) {
      const ackId = uuidv4();
      store.addEvent(connectionId, { direction: 'sent', ...logged, ackId });

      const pending = this.browserAcks.get(connectionId) ?? new Map<string, PendingAck>();
      const timer = setTimeout(() => {
        const acks = this.browserAcks.get(connectionId);
        if (acks?.has(ackId)) {
          acks.delete(ackId);
          useSocketIOStore.getState().resolveAck(connectionId, ackId, [], 'timeout');
        }
      }, ackTimeoutMs);
      pending.set(ackId, {
        timer,
        resolve: (ackArgs) => {
          useSocketIOStore.getState().resolveAck(connectionId, ackId, ackArgs, 'ok');
        },
      });
      this.browserAcks.set(connectionId, pending);

      emitter.emit(eventName, ...args, (...ackArgs: unknown[]) => {
        const acks = this.browserAcks.get(connectionId);
        const p = acks?.get(ackId);
        if (!p) return;
        clearTimeout(p.timer);
        acks!.delete(ackId);
        p.resolve(prepareIncomingArgs(ackArgs).args);
      });
    } else {
      store.addEvent(connectionId, { direction: 'sent', ...logged });
      emitter.emit(eventName, ...args);
    }
  }

  /**
   * Answer a server-requested acknowledgement (SIO-1). `display` keeps
   * resolved secrets out of the logged copy, as for emits.
   */
  replyServerAck(
    connectionId: string,
    serverAckId: string,
    args: unknown[],
    display?: { args: unknown[] }
  ): void {
    const logReply = () => {
      const s = useSocketIOStore.getState();
      s.markServerAckReplied(connectionId, serverAckId);
      s.addEvent(connectionId, {
        direction: 'sent',
        eventName: '<ack reply>',
        args: display?.args ?? encodeBinaryArgs(args),
      });
    };
    const logFailure = (message: string) =>
      useSocketIOStore.getState().addEvent(connectionId, {
        direction: 'system',
        eventName: '<system>',
        args: [`Ack reply failed: ${message}`],
      });

    if (this.electronConnections.has(connectionId)) {
      const api = getElectronAPI();
      if (!api?.socketio) return;
      if (this.inFlightServerAckReplies.has(serverAckId)) return;
      this.inFlightServerAckReplies.add(serverAckId);
      void api.socketio
        .replyAck({ connectionId, serverAckId, args })
        .then((res) => (res?.success ? logReply() : logFailure(res?.error ?? 'unknown error')))
        .catch((err: unknown) => logFailure(err instanceof Error ? err.message : 'IPC error'))
        .finally(() => this.inFlightServerAckReplies.delete(serverAckId));
      return;
    }

    const acks = this.browserServerAcks.get(connectionId);
    const ack = acks?.get(serverAckId);
    if (!ack) {
      logFailure('acknowledgement already answered or expired');
      return;
    }
    acks!.delete(serverAckId);
    try {
      ack(...args);
      logReply();
    } catch (err) {
      logFailure(err instanceof Error ? err.message : 'unknown error');
    }
  }

  /** Whether a server-requested ack can still be answered from this renderer. */
  canReplyServerAck(connectionId: string, serverAckId: string): boolean {
    if (this.electronConnections.has(connectionId)) return this.isConnected(connectionId);
    return this.browserServerAcks.get(connectionId)?.has(serverAckId) ?? false;
  }

  disconnect(connectionId: string): void {
    const store = useSocketIOStore.getState();

    if (this.electronConnections.has(connectionId)) {
      const api = getElectronAPI();
      void api?.socketio?.disconnect({ connectionId });
      this.electronConnections.delete(connectionId);
      this.cleanupElectronListeners(connectionId);
      this.subscriptions.delete(connectionId);
      store.updateConnectionStatus(connectionId, 'disconnected');
      return;
    }

    const socket = this.browserSockets.get(connectionId);
    if (socket) {
      try {
        socket.removeAllListeners();
      } catch {
        /* ignore */
      }
      try {
        socket.disconnect();
      } catch {
        /* ignore */
      }
      this.browserSockets.delete(connectionId);
    }
    const acks = this.browserAcks.get(connectionId);
    if (acks) {
      for (const p of acks.values()) clearTimeout(p.timer);
      this.browserAcks.delete(connectionId);
    }
    this.browserServerAcks.delete(connectionId);
    this.subscriptions.delete(connectionId);
    store.updateConnectionStatus(connectionId, 'disconnected');
  }

  isConnected(connectionId: string): boolean {
    if (this.electronConnections.has(connectionId)) {
      return useSocketIOStore.getState().connections[connectionId]?.status === 'connected';
    }
    return this.browserSockets.get(connectionId)?.connected ?? false;
  }

  cleanup(): void {
    for (const id of Array.from(this.browserSockets.keys())) this.disconnect(id);
    for (const id of Array.from(this.electronConnections)) this.disconnect(id);
  }

  private connectViaBrowser(connectionId: string, config: ConnectConfig): void {
    const store = useSocketIOStore.getState();
    const url = buildSocketIOConnectUrl(config.url, config.namespace);

    // Browser-direct: the Worker's SSRF guard never sees this socket (#898).
    const target = checkBrowserSocketTargetFromSettings(url);
    if (!target.ok) {
      store.addEvent(connectionId, {
        direction: 'system',
        eventName: '<system>',
        args: [`Connection refused: ${target.error}`],
      });
      store.updateConnectionStatus(connectionId, 'disconnected');
      return;
    }

    let socket: Socket;
    try {
      socket = ioClient(url, {
        path: config.path,
        auth: config.auth,
        query: config.query,
        // extraHeaders only works on polling transport in browsers
        extraHeaders: config.extraHeaders,
        transports: config.transports,
        reconnection: config.reconnection,
        reconnectionAttempts: config.reconnectionAttempts,
        reconnectionDelay: config.reconnectionDelay,
        reconnectionDelayMax: config.reconnectionDelayMax,
        randomizationFactor: config.randomizationFactor,
        timeout: config.timeout,
        forceNew: config.forceNew,
        autoConnect: true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to construct socket';
      store.addEvent(connectionId, {
        direction: 'system',
        eventName: '<system>',
        args: [`Connection failed: ${msg}`],
      });
      store.updateConnectionStatus(connectionId, 'disconnected');
      return;
    }

    socket.on('connect', () => {
      const s = useSocketIOStore.getState();
      s.updateConnectionStatus(connectionId, 'connected');
      s.setReconnectAttemptCount(connectionId, 0);
      s.setLastConnectedAt(connectionId, Date.now());
      s.addEvent(connectionId, {
        direction: 'system',
        eventName: 'connect',
        args: [{ socketId: socket.id }],
      });
    });

    socket.on('disconnect', (reason: Socket.DisconnectReason) => {
      const s = useSocketIOStore.getState();
      s.updateConnectionStatus(connectionId, 'disconnected');
      s.addEvent(connectionId, { direction: 'system', eventName: 'disconnect', args: [reason] });
    });

    socket.on('connect_error', (err: Error) => {
      useSocketIOStore.getState().addEvent(connectionId, {
        direction: 'system',
        eventName: 'connect_error',
        args: [err.message],
      });
    });

    socket.io.on('reconnect_attempt', (attempt: number) => {
      const s = useSocketIOStore.getState();
      s.updateConnectionStatus(connectionId, 'reconnecting');
      s.setReconnectAttemptCount(connectionId, attempt);
      s.addEvent(connectionId, {
        direction: 'system',
        eventName: 'reconnect_attempt',
        args: [{ attempt }],
      });
    });

    socket.io.on('reconnect', (attempt: number) => {
      useSocketIOStore.getState().addEvent(connectionId, {
        direction: 'system',
        eventName: 'reconnect',
        args: [{ attempt }],
      });
    });

    socket.io.on('reconnect_failed', () => {
      useSocketIOStore.getState().addEvent(connectionId, {
        direction: 'system',
        eventName: 'reconnect_failed',
        args: [],
      });
    });

    // Same shaping as the desktop handler: the server-requested ack callback
    // is split off and kept here, binary is encoded, oversize payloads dropped.
    socket.onAny((eventName: string, ...rawArgs: unknown[]) => {
      if (SOCKETIO_RESERVED_EVENTS.has(eventName)) return;
      const { args, ack } = prepareIncomingArgs(rawArgs);
      let serverAckId: string | undefined;
      if (ack) {
        serverAckId = uuidv4();
        const acks = this.browserServerAcks.get(connectionId) ?? new Map();
        acks.set(serverAckId, ack);
        if (acks.size > MAX_PENDING_SERVER_ACKS) {
          const oldest = acks.keys().next().value;
          if (oldest !== undefined) acks.delete(oldest);
        }
        this.browserServerAcks.set(connectionId, acks);
      }
      useSocketIOStore.getState().addEvent(connectionId, {
        direction: 'received',
        eventName,
        args,
        ...(serverAckId ? { serverAckId } : {}),
      });
    });

    this.browserSockets.set(connectionId, socket);
  }

  private connectViaElectron(connectionId: string, config: ConnectConfig): void {
    const api = getElectronAPI();
    if (!api?.socketio) {
      const s = useSocketIOStore.getState();
      s.addEvent(connectionId, {
        direction: 'system',
        eventName: '<system>',
        args: ['Electron Socket.IO API is unavailable.'],
      });
      s.updateConnectionStatus(connectionId, 'disconnected');
      return;
    }

    api.socketio.on(socketioChannels.open(connectionId), (payload: unknown) => {
      const data = payload as { socketId?: string } | undefined;
      const s = useSocketIOStore.getState();
      s.updateConnectionStatus(connectionId, 'connected');
      s.setReconnectAttemptCount(connectionId, 0);
      s.setLastConnectedAt(connectionId, Date.now());
      s.addEvent(connectionId, {
        direction: 'system',
        eventName: 'connect',
        args: [{ socketId: data?.socketId }],
      });
    });

    api.socketio.on(socketioChannels.close(connectionId), (payload: unknown) => {
      const data = payload as { reason?: string } | undefined;
      const s = useSocketIOStore.getState();
      s.updateConnectionStatus(connectionId, 'disconnected');
      s.addEvent(connectionId, {
        direction: 'system',
        eventName: 'disconnect',
        args: [data?.reason ?? 'unknown'],
      });
    });

    api.socketio.on(socketioChannels.error(connectionId), (payload: unknown) => {
      const data = payload as { message?: string } | undefined;
      useSocketIOStore.getState().addEvent(connectionId, {
        direction: 'system',
        eventName: 'connect_error',
        args: [data?.message ?? 'unknown error'],
      });
    });

    api.socketio.on(socketioChannels.reconnectAttempt(connectionId), (payload: unknown) => {
      const data = payload as { attempt?: number } | undefined;
      const s = useSocketIOStore.getState();
      s.updateConnectionStatus(connectionId, 'reconnecting');
      if (typeof data?.attempt === 'number') {
        s.setReconnectAttemptCount(connectionId, data.attempt);
      }
      s.addEvent(connectionId, {
        direction: 'system',
        eventName: 'reconnect_attempt',
        args: [{ attempt: data?.attempt }],
      });
    });

    api.socketio.on(socketioChannels.reconnect(connectionId), (payload: unknown) => {
      useSocketIOStore.getState().addEvent(connectionId, {
        direction: 'system',
        eventName: 'reconnect',
        args: [payload ?? {}],
      });
    });

    api.socketio.on(socketioChannels.reconnectFailed(connectionId), () => {
      useSocketIOStore.getState().addEvent(connectionId, {
        direction: 'system',
        eventName: 'reconnect_failed',
        args: [],
      });
    });

    api.socketio.on(socketioChannels.event(connectionId), (payload: unknown) => {
      const data = payload as
        | { eventName?: string; args?: unknown[]; serverAckId?: string }
        | undefined;
      if (!data?.eventName) return;
      useSocketIOStore.getState().addEvent(connectionId, {
        direction: 'received',
        eventName: data.eventName,
        args: data.args ?? [],
        ...(typeof data.serverAckId === 'string' ? { serverAckId: data.serverAckId } : {}),
      });
    });

    api.socketio.on(socketioChannels.ack(connectionId), (payload: unknown) => {
      const data = payload as { ackId?: string; args?: unknown[]; error?: string } | undefined;
      if (!data?.ackId) return;
      useSocketIOStore
        .getState()
        .resolveAck(
          connectionId,
          data.ackId,
          data.args ?? [],
          data.error === 'timeout' ? 'timeout' : 'ok'
        );
    });

    this.electronConnections.add(connectionId);

    void api.socketio
      .connect({
        connectionId,
        url: config.url,
        namespace: config.namespace,
        path: config.path,
        auth: config.auth,
        query: config.query,
        extraHeaders: config.extraHeaders,
        transports: config.transports,
        reconnection: config.reconnection,
        reconnectionAttempts: config.reconnectionAttempts,
        reconnectionDelay: config.reconnectionDelay,
        reconnectionDelayMax: config.reconnectionDelayMax,
        randomizationFactor: config.randomizationFactor,
        timeout: config.timeout,
        forceNew: config.forceNew,
      })
      .then((res) => {
        if (!res?.success) {
          this.handleElectronConnectFailure(connectionId, res?.error ?? 'Connection failed');
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : 'Connection failed';
        this.handleElectronConnectFailure(connectionId, msg);
      });
  }

  private handleElectronConnectFailure(connectionId: string, message: string): void {
    const s = useSocketIOStore.getState();
    s.addEvent(connectionId, {
      direction: 'system',
      eventName: '<system>',
      args: [`Failed to connect: ${message}`],
    });
    s.updateConnectionStatus(connectionId, 'disconnected');
    this.electronConnections.delete(connectionId);
    this.cleanupElectronListeners(connectionId);
  }

  private cleanupElectronListeners(connectionId: string): void {
    const api = getElectronAPI();
    if (!api?.socketio) return;
    const channels = [
      socketioChannels.open(connectionId),
      socketioChannels.close(connectionId),
      socketioChannels.error(connectionId),
      socketioChannels.event(connectionId),
      socketioChannels.ack(connectionId),
      socketioChannels.reconnectAttempt(connectionId),
      socketioChannels.reconnect(connectionId),
      socketioChannels.reconnectFailed(connectionId),
    ];
    for (const ch of channels) api.socketio.removeAllListeners(ch);
  }
}

export const socketioManager = new SocketIOManager();
