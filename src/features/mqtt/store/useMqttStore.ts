import { v4 as uuidv4 } from 'uuid';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { mqttManager } from '@/features/mqtt/lib/mqttManager';
import { dexieStorageAdapters } from '@/lib/shared/dexie-storage';
import { capMessages, MAX_MESSAGES_PER_CONNECTION } from '@/lib/shared/message-cap';
import { passthroughMigrate } from '@/lib/shared/persistMigrate';
import { useConsoleStore } from '@/store/useConsoleStore';

/** 4 = MQTT 3.1.1, 5 = MQTT 5.0. */
export type MqttProtocolVersion = 4 | 5;
export type MqttQoS = 0 | 1 | 2;
export type MqttMessageDirection = 'sent' | 'received' | 'system';

/**
 * Sentinel marker for secrets the store must never serialize in clear.
 * The real value lives in secureStorage (electron-store + safeStorage) and
 * is resolved by `mqttManager` just before the IPC call.
 */
export const MQTT_SECRET_SENTINEL = '__restura_secret__';

export interface MqttTls {
  caPath?: string;
  certPath?: string;
  keyPath?: string;
  /** Persisted as the sentinel; real value comes from secureStorage */
  passphrase?: string;
  rejectUnauthorized?: boolean;
}

export interface MqttLwt {
  topic: string;
  payload: string;
  qos: MqttQoS;
  retain: boolean;
}

export interface MqttSubscription {
  topicFilter: string;
  requestedQos: MqttQoS;
  grantedQos?: MqttQoS;
  status: 'subscribing' | 'subscribed' | 'error';
}

export interface MqttMessage {
  id: string;
  direction: MqttMessageDirection;
  topic: string;
  qos: MqttQoS;
  retain: boolean;
  dup?: boolean;
  payload: string;
  // MQTT 5.0 metadata (undefined on a v3.1.1 connection)
  userProperties?: Record<string, string | string[]>;
  messageExpiryInterval?: number;
  contentType?: string;
  responseTopic?: string;
  // MQTT 5 request/response correlation token (received messages).
  correlationData?: string;
  // MQTT 5 subscription identifier(s) — which subscription matched this message.
  subscriptionIdentifier?: number | number[];
  reasonCode?: number;
  packetId?: number;
  timestamp: number;
  error?: string;
}

export interface MqttConnection {
  id: string;
  name: string;
  brokerUrl: string;
  protocolVersion: MqttProtocolVersion;
  clientId: string;
  keepalive: number;
  cleanStart: boolean;
  connectTimeout: number;
  autoReconnect: boolean;
  username?: string;
  /** Persisted as the sentinel; real value comes from secureStorage */
  password?: string;
  tls?: MqttTls;
  lwt?: MqttLwt;
  /** MQTT 5.0 only */
  sessionExpiryInterval?: number;
  status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
  // Active subscriptions
  subscriptions: MqttSubscription[];
  messages: MqttMessage[];
  createdAt: number;
  lastConnectedAt?: number;
}

interface MqttState {
  connections: Record<string, MqttConnection>;
  activeConnectionId: string | null;
  /** Workspace-tab → connection mapping (mirrors useKafkaStore). */
  connectionByTabId: Record<string, string>;
  messageFilter: MqttMessageDirection | 'all';
  searchQuery: string;

  // Lifecycle
  createConnection: (
    init?: Partial<Pick<MqttConnection, 'name' | 'brokerUrl' | 'clientId'>>
  ) => string;
  removeConnection: (id: string) => void;
  setActiveConnection: (id: string | null) => void;
  ensureConnectionForTab: (tabId: string) => string;
  cleanupConnectionForTab: (tabId: string) => void;

  // Connection metadata
  updateConnection: (
    id: string,
    patch: Partial<Omit<MqttConnection, 'id' | 'createdAt' | 'messages' | 'subscriptions'>>
  ) => void;
  updateTls: (id: string, tls: MqttTls | undefined) => void;
  updateLwt: (id: string, lwt: MqttLwt | undefined) => void;
  updateStatus: (id: string, status: MqttConnection['status']) => void;

  // Subscriptions
  upsertSubscription: (connectionId: string, sub: MqttSubscription) => void;
  patchSubscription: (
    connectionId: string,
    topicFilter: string,
    patch: Partial<MqttSubscription>
  ) => void;
  removeSubscription: (connectionId: string, topicFilter: string) => void;

  // Messages
  addMessage: (
    connectionId: string,
    message: Omit<MqttMessage, 'id' | 'timestamp'> & { timestamp?: number }
  ) => void;
  /** Batch append — one store update + one console-frame batch for many inbound messages. */
  addMessages: (
    connectionId: string,
    messages: Array<Omit<MqttMessage, 'id' | 'timestamp'> & { timestamp?: number }>
  ) => void;
  clearMessages: (connectionId: string) => void;

  // Filter
  setMessageFilter: (filter: MqttMessageDirection | 'all') => void;
  setSearchQuery: (q: string) => void;

  // Selectors
  getActiveConnection: () => MqttConnection | null;
  getFilteredMessages: (connectionId: string) => MqttMessage[];
}

function toConsoleFrame(connectionId: string, m: MqttMessage) {
  return {
    timestamp: m.timestamp,
    protocol: 'mqtt' as const,
    direction:
      m.direction === 'sent'
        ? ('out' as const)
        : m.direction === 'received'
          ? ('in' as const)
          : ('system' as const),
    connectionId,
    label: m.topic,
    payload: m.payload ?? '',
  };
}

function makeDefaultConnection(
  init?: Partial<Pick<MqttConnection, 'name' | 'brokerUrl' | 'clientId'>>
): MqttConnection {
  const id = uuidv4();
  return {
    id,
    name: init?.name ?? 'MQTT connection',
    brokerUrl: init?.brokerUrl ?? 'mqtt://localhost:1883',
    protocolVersion: 5,
    clientId: init?.clientId ?? `restura-${id.slice(0, 8)}`,
    keepalive: 60,
    cleanStart: true,
    connectTimeout: 30_000,
    autoReconnect: true,
    status: 'disconnected',
    subscriptions: [],
    messages: [],
    createdAt: Date.now(),
  };
}

export const useMqttStore = create<MqttState>()(
  persist(
    (set, get) => ({
      connections: {},
      activeConnectionId: null,
      connectionByTabId: {},
      messageFilter: 'all',
      searchQuery: '',

      createConnection: (init) => {
        const conn = makeDefaultConnection(init);
        set((state) => ({
          connections: { ...state.connections, [conn.id]: conn },
          activeConnectionId: conn.id,
        }));
        return conn.id;
      },

      ensureConnectionForTab: (tabId) => {
        const existing = get().connectionByTabId[tabId];
        if (existing && get().connections[existing]) {
          if (get().activeConnectionId !== existing) set({ activeConnectionId: existing });
          return existing;
        }
        const id = get().createConnection();
        set((state) => ({
          connectionByTabId: { ...state.connectionByTabId, [tabId]: id },
          activeConnectionId: id,
        }));
        return id;
      },

      cleanupConnectionForTab: (tabId) => {
        const connectionId = get().connectionByTabId[tabId];
        if (!connectionId) return;
        try {
          void mqttManager.disconnect(connectionId);
        } catch {
          /* ignore — manager handles missing/already-closed connections */
        }
        set((state) => {
          const { [connectionId]: _drop, ...restConns } = state.connections;
          const { [tabId]: _dropTab, ...restMap } = state.connectionByTabId;
          return {
            connections: restConns,
            connectionByTabId: restMap,
            activeConnectionId:
              state.activeConnectionId === connectionId ? null : state.activeConnectionId,
          };
        });
      },

      removeConnection: (id) =>
        set((state) => {
          const { [id]: _removed, ...rest } = state.connections;
          const nextMap = Object.fromEntries(
            Object.entries(state.connectionByTabId).filter(([, cid]) => cid !== id)
          );
          return {
            connections: rest,
            connectionByTabId: nextMap,
            activeConnectionId: state.activeConnectionId === id ? null : state.activeConnectionId,
          };
        }),

      setActiveConnection: (id) => set({ activeConnectionId: id }),

      updateConnection: (id, patch) =>
        set((state) => {
          const conn = state.connections[id];
          if (!conn) return state;
          return { connections: { ...state.connections, [id]: { ...conn, ...patch } } };
        }),

      updateTls: (id, tls) =>
        set((state) => {
          const conn = state.connections[id];
          if (!conn) return state;
          const next = { ...conn };
          if (tls === undefined) delete next.tls;
          else next.tls = tls;
          return { connections: { ...state.connections, [id]: next } };
        }),

      updateLwt: (id, lwt) =>
        set((state) => {
          const conn = state.connections[id];
          if (!conn) return state;
          const next = { ...conn };
          if (lwt === undefined) delete next.lwt;
          else next.lwt = lwt;
          return { connections: { ...state.connections, [id]: next } };
        }),

      updateStatus: (id, status) =>
        set((state) => {
          const conn = state.connections[id];
          if (!conn) return state;
          const next: MqttConnection =
            status === 'connected'
              ? { ...conn, status, lastConnectedAt: Date.now() }
              : { ...conn, status };
          return { connections: { ...state.connections, [id]: next } };
        }),

      upsertSubscription: (connectionId, sub) =>
        set((state) => {
          const conn = state.connections[connectionId];
          if (!conn) return state;
          const others = conn.subscriptions.filter((s) => s.topicFilter !== sub.topicFilter);
          return {
            connections: {
              ...state.connections,
              [connectionId]: { ...conn, subscriptions: [...others, sub] },
            },
          };
        }),

      patchSubscription: (connectionId, topicFilter, patch) =>
        set((state) => {
          const conn = state.connections[connectionId];
          if (!conn) return state;
          return {
            connections: {
              ...state.connections,
              [connectionId]: {
                ...conn,
                subscriptions: conn.subscriptions.map((s) =>
                  s.topicFilter === topicFilter ? { ...s, ...patch } : s
                ),
              },
            },
          };
        }),

      removeSubscription: (connectionId, topicFilter) =>
        set((state) => {
          const conn = state.connections[connectionId];
          if (!conn) return state;
          return {
            connections: {
              ...state.connections,
              [connectionId]: {
                ...conn,
                subscriptions: conn.subscriptions.filter((s) => s.topicFilter !== topicFilter),
              },
            },
          };
        }),

      addMessage: (connectionId, message) =>
        set((state) => {
          const conn = state.connections[connectionId];
          if (!conn) return state;
          const next: MqttMessage = {
            ...message,
            id: uuidv4(),
            timestamp: message.timestamp ?? Date.now(),
          };

          useConsoleStore.getState().addFrame(toConsoleFrame(connectionId, next));

          return {
            connections: {
              ...state.connections,
              [connectionId]: { ...conn, messages: capMessages(conn.messages, next) },
            },
          };
        }),

      addMessages: (connectionId, messages) =>
        set((state) => {
          const conn = state.connections[connectionId];
          if (!conn || messages.length === 0) return state;
          const built: MqttMessage[] = messages.map((m) => ({
            ...m,
            id: uuidv4(),
            timestamp: m.timestamp ?? Date.now(),
          }));

          useConsoleStore.getState().addFrames(built.map((m) => toConsoleFrame(connectionId, m)));

          const merged = conn.messages.concat(built);
          const capped =
            merged.length > MAX_MESSAGES_PER_CONNECTION
              ? merged.slice(merged.length - MAX_MESSAGES_PER_CONNECTION)
              : merged;
          return {
            connections: { ...state.connections, [connectionId]: { ...conn, messages: capped } },
          };
        }),

      clearMessages: (connectionId) =>
        set((state) => {
          const conn = state.connections[connectionId];
          if (!conn) return state;
          return {
            connections: { ...state.connections, [connectionId]: { ...conn, messages: [] } },
          };
        }),

      setMessageFilter: (filter) => set({ messageFilter: filter }),
      setSearchQuery: (q) => set({ searchQuery: q }),

      getActiveConnection: () => {
        const { connections, activeConnectionId } = get();
        return activeConnectionId ? (connections[activeConnectionId] ?? null) : null;
      },

      getFilteredMessages: (connectionId) => {
        const { connections, messageFilter, searchQuery } = get();
        const conn = connections[connectionId];
        if (!conn) return [];
        let messages = conn.messages;
        if (messageFilter !== 'all') {
          messages = messages.filter((m) => m.direction === messageFilter);
        }
        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase();
          messages = messages.filter(
            (m) => m.payload.toLowerCase().includes(q) || m.topic.toLowerCase().includes(q)
          );
        }
        return messages;
      },
    }),
    {
      name: 'mqtt-storage',
      // v1: explicit versioning seam; no shape change from the unversioned blob.
      version: 1,
      migrate: (persisted) => passthroughMigrate<MqttState>(persisted),
      storage: dexieStorageAdapters.mqttConnections(),
      partialize: (state) => ({
        connections: Object.fromEntries(
          Object.entries(state.connections).map(([id, conn]) => [
            id,
            {
              ...conn,
              // Never persist runtime state — and never persist plaintext
              // secrets. The renderer keeps sentinels; resolution happens at
              // IPC time in the main process.
              status: 'disconnected' as const,
              messages: [] as MqttMessage[],
              subscriptions: [] as MqttSubscription[],
              password: conn.password ? MQTT_SECRET_SENTINEL : undefined,
              ...(conn.tls
                ? {
                    tls: {
                      ...conn.tls,
                      passphrase: conn.tls.passphrase ? MQTT_SECRET_SENTINEL : undefined,
                    },
                  }
                : {}),
            },
          ])
        ),
        activeConnectionId: state.activeConnectionId,
        connectionByTabId: state.connectionByTabId,
      }),
    }
  )
);
