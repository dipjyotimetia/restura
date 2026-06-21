import { io as ioClient, type Socket } from 'socket.io-client';
import { v4 as uuidv4 } from 'uuid';
import { isElectron, getElectronAPI } from '@/lib/shared/platform';
import { keyValuePairsToRecord } from '@/lib/shared/utils';
import {
  useSocketIOStore,
  type SocketIOTransport,
} from '@/features/socketio/store/useSocketIOStore';
import { buildSocketIOConnectUrl, validateSocketIOUrl } from '@/features/socketio/lib/url-helpers';
import { SOCKETIO_RESERVED_EVENTS, socketioChannels } from '@shared/socketio-constants';

interface ConnectConfig {
  url: string;
  namespace: string;
  path: string;
  auth: Record<string, string>;
  query: Record<string, string>;
  extraHeaders: Record<string, string>;
  transports: SocketIOTransport[];
  reconnection: boolean;
  reconnectionAttempts: number;
  reconnectionDelay: number;
  timeout: number;
  forceNew: boolean;
}

interface PendingAck {
  resolve: (args: unknown[]) => void;
  timer: ReturnType<typeof setTimeout>;
}

class SocketIOManager {
  private browserSockets = new Map<string, Socket>();
  private electronConnections = new Set<string>();
  private subscriptions = new Map<string, Set<string>>(); // connectionId → eventNames
  private browserAcks = new Map<string, Map<string, PendingAck>>(); // connectionId → ackId → pending

  connect(connectionId: string): void {
    const store = useSocketIOStore.getState();
    const connection = store.connections[connectionId];
    if (!connection) return;

    this.disconnect(connectionId);

    const v = validateSocketIOUrl(connection.url);
    if (!v.valid) {
      store.addEvent(connectionId, {
        direction: 'system',
        eventName: '<system>',
        args: [`Connection failed: ${v.error}`],
      });
      store.updateConnectionStatus(connectionId, 'disconnected');
      return;
    }

    const config: ConnectConfig = {
      url: connection.url,
      namespace: connection.namespace || '/',
      path: connection.path || '/socket.io',
      auth: keyValuePairsToRecord(connection.auth),
      query: keyValuePairsToRecord(connection.query),
      extraHeaders: keyValuePairsToRecord(connection.extraHeaders),
      transports:
        connection.transports.length > 0 ? connection.transports : ['websocket', 'polling'],
      reconnection: connection.autoReconnect,
      reconnectionAttempts: connection.reconnectionAttempts,
      reconnectionDelay: connection.reconnectionDelay,
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

  emit(connectionId: string, eventName: string, args: unknown[], withAck = false): void {
    const store = useSocketIOStore.getState();

    if (this.electronConnections.has(connectionId)) {
      const api = getElectronAPI();
      if (!api?.socketio) return;
      const ackId = withAck ? uuidv4() : undefined;
      store.addEvent(connectionId, {
        direction: 'sent',
        eventName,
        args,
        ...(ackId ? { ackId } : {}),
      });
      void api.socketio.emit({ connectionId, eventName, args, ...(ackId ? { ackId } : {}) });
      return;
    }

    const socket = this.browserSockets.get(connectionId);
    if (!socket || !socket.connected) {
      store.addEvent(connectionId, {
        direction: 'system',
        eventName: '<system>',
        args: ['Cannot emit: socket is not connected'],
      });
      return;
    }

    if (withAck) {
      const ackId = uuidv4();
      store.addEvent(connectionId, { direction: 'sent', eventName, args, ackId });

      const pending = this.browserAcks.get(connectionId) ?? new Map<string, PendingAck>();
      const timer = setTimeout(() => {
        const acks = this.browserAcks.get(connectionId);
        if (acks?.has(ackId)) {
          acks.delete(ackId);
          useSocketIOStore.getState().resolveAck(connectionId, ackId, [], 'timeout');
        }
      }, 15_000);
      pending.set(ackId, {
        timer,
        resolve: (ackArgs) => {
          useSocketIOStore.getState().resolveAck(connectionId, ackId, ackArgs, 'ok');
        },
      });
      this.browserAcks.set(connectionId, pending);

      socket.emit(eventName, ...args, (...ackArgs: unknown[]) => {
        const acks = this.browserAcks.get(connectionId);
        const p = acks?.get(ackId);
        if (!p) return;
        clearTimeout(p.timer);
        acks!.delete(ackId);
        p.resolve(ackArgs);
      });
    } else {
      store.addEvent(connectionId, { direction: 'sent', eventName, args });
      socket.emit(eventName, ...args);
    }
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

    socket.onAny((eventName: string, ...args: unknown[]) => {
      if (SOCKETIO_RESERVED_EVENTS.has(eventName)) return;
      useSocketIOStore.getState().addEvent(connectionId, {
        direction: 'received',
        eventName,
        args,
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
      const data = payload as { eventName?: string; args?: unknown[] } | undefined;
      if (!data?.eventName) return;
      useSocketIOStore.getState().addEvent(connectionId, {
        direction: 'received',
        eventName: data.eventName,
        args: data.args ?? [],
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
