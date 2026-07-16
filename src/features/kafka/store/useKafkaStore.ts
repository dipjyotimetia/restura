import { v4 as uuidv4 } from 'uuid';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { capMessages } from '@/lib/shared/message-cap';
import { createPersistedStore } from '@/lib/shared/persistence/createPersistedStore';
import { useConsoleStore } from '@/store/useConsoleStore';

export type KafkaSecurityProtocol = 'PLAINTEXT' | 'SASL_PLAINTEXT' | 'SASL_SSL' | 'SSL';
export type KafkaSaslMechanism = 'PLAIN' | 'SCRAM-SHA-256' | 'SCRAM-SHA-512';
export type KafkaCompression = 'none' | 'gzip' | 'snappy' | 'lz4' | 'zstd';
export type KafkaAcks = 0 | 1 | -1;

/**
 * Sentinel marker for secrets the store must never serialize in clear.
 * The real value lives in secureStorage (electron-store + safeStorage) and
 * is resolved by `kafkaManager` just before the IPC call.
 */
export const KAFKA_SECRET_SENTINEL = '__restura_secret__';

export interface KafkaSasl {
  mechanism: KafkaSaslMechanism;
  username: string;
  /** Persisted as the sentinel; real value comes from secureStorage */
  password: string;
}

export interface KafkaTls {
  caPath?: string;
  certPath?: string;
  keyPath?: string;
  /** Persisted as the sentinel; real value comes from secureStorage */
  passphrase?: string;
  rejectUnauthorized?: boolean;
}

export interface KafkaAuth {
  securityProtocol: KafkaSecurityProtocol;
  sasl?: KafkaSasl;
  tls?: KafkaTls;
}

/**
 * Confluent Schema Registry config. When set, the consumer decodes
 * Avro/Protobuf/JSON Schema messages via the registry. Auth secrets persist as
 * the sentinel; real values live in secureStorage (resolved by kafkaManager).
 */
export interface KafkaRegistry {
  url: string;
  auth?: {
    username?: string;
    /** Persisted as the sentinel; real value comes from secureStorage */
    password?: string;
    /** Persisted as the sentinel; real value comes from secureStorage */
    token?: string;
  };
}

export interface KafkaProducedAck {
  topic: string;
  partition: number;
  offset: string;
  timestamp: number;
}

export type KafkaMessageDirection = 'sent' | 'received' | 'system';

export interface KafkaMessage {
  id: string;
  direction: KafkaMessageDirection;
  topic: string;
  partition?: number;
  offset?: string;
  key?: string;
  value: string;
  headers?: Record<string, string>;
  timestamp: number;
  error?: string;
}

export interface KafkaConsumerState {
  groupId: string;
  topics: string[];
  fromBeginning: boolean;
  status: 'idle' | 'subscribing' | 'subscribed' | 'error';
}

export interface KafkaConnection {
  id: string;
  name: string;
  clientId: string;
  bootstrapBrokers: string[];
  auth: KafkaAuth;
  status: 'disconnected' | 'connecting' | 'connected';
  defaultTopic: string;
  defaultPartitionKey: string;
  acks: KafkaAcks;
  compression: KafkaCompression;
  /** Idempotent producer — exactly-once-per-partition dedup; forces acks=-1. */
  idempotent: boolean;
  /** Optional Confluent Schema Registry — enables Avro/Protobuf/JSON decode. */
  registry?: KafkaRegistry;
  consumer: KafkaConsumerState;
  messages: KafkaMessage[];
  createdAt: number;
  lastConnectedAt?: number;
}

interface KafkaState {
  connections: Record<string, KafkaConnection>;
  activeConnectionId: string | null;
  /** Workspace-tab → connection mapping (mirrors useWebSocketStore). */
  connectionByTabId: Record<string, string>;
  messageFilter: KafkaMessageDirection | 'all';
  searchQuery: string;

  // Lifecycle
  createConnection: (
    init?: Partial<Pick<KafkaConnection, 'name' | 'bootstrapBrokers' | 'clientId'>>
  ) => string;
  removeConnection: (id: string) => void;
  setActiveConnection: (id: string | null) => void;
  /** Idempotent — returns the existing tab connection or creates a fresh one. */
  ensureConnectionForTab: (tabId: string) => string;
  /** Disconnects (async, best-effort) and removes the connection bound to `tabId`. */
  cleanupConnectionForTab: (tabId: string) => void;

  // Connection metadata
  updateConnection: (
    id: string,
    patch: Partial<Omit<KafkaConnection, 'id' | 'createdAt' | 'messages' | 'consumer'>>
  ) => void;
  updateAuth: (id: string, auth: KafkaAuth) => void;
  updateConsumer: (id: string, patch: Partial<KafkaConsumerState>) => void;
  /**
   * Setting `status` to `'connected'` also stamps `lastConnectedAt`. Co-locating
   * the two writes keeps callers from accidentally setting one without the other.
   */
  updateStatus: (id: string, status: KafkaConnection['status']) => void;

  // Messages
  addMessage: (
    connectionId: string,
    message: Omit<KafkaMessage, 'id' | 'timestamp'> & { timestamp?: number }
  ) => void;
  clearMessages: (connectionId: string) => void;

  // Filter
  setMessageFilter: (filter: KafkaMessageDirection | 'all') => void;
  setSearchQuery: (q: string) => void;

  // Selectors
  getActiveConnection: () => KafkaConnection | null;
  getFilteredMessages: (connectionId: string) => KafkaMessage[];
}

function makeDefaultConnection(
  init?: Partial<Pick<KafkaConnection, 'name' | 'bootstrapBrokers' | 'clientId'>>
): KafkaConnection {
  const id = uuidv4();
  return {
    id,
    name: init?.name ?? 'Kafka connection',
    clientId: init?.clientId ?? `restura-${id.slice(0, 8)}`,
    bootstrapBrokers: init?.bootstrapBrokers ?? ['localhost:9092'],
    auth: { securityProtocol: 'PLAINTEXT' },
    status: 'disconnected',
    defaultTopic: '',
    defaultPartitionKey: '',
    acks: 1,
    compression: 'none',
    idempotent: false,
    consumer: {
      groupId: `restura-${id.slice(0, 8)}`,
      topics: [],
      fromBeginning: false,
      status: 'idle',
    },
    messages: [],
    createdAt: Date.now(),
  };
}

export const useKafkaStore = create<KafkaState>()(
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
          return {
            connections: { ...state.connections, [id]: { ...conn, ...patch } },
          };
        }),

      updateAuth: (id, auth) =>
        set((state) => {
          const conn = state.connections[id];
          if (!conn) return state;
          return {
            connections: { ...state.connections, [id]: { ...conn, auth } },
          };
        }),

      updateConsumer: (id, patch) =>
        set((state) => {
          const conn = state.connections[id];
          if (!conn) return state;
          return {
            connections: {
              ...state.connections,
              [id]: { ...conn, consumer: { ...conn.consumer, ...patch } },
            },
          };
        }),

      updateStatus: (id, status) =>
        set((state) => {
          const conn = state.connections[id];
          if (!conn) return state;
          const next: KafkaConnection =
            status === 'connected'
              ? { ...conn, status, lastConnectedAt: Date.now() }
              : { ...conn, status };
          return { connections: { ...state.connections, [id]: next } };
        }),

      addMessage: (connectionId, message) =>
        set((state) => {
          const conn = state.connections[connectionId];
          if (!conn) return state;
          const next: KafkaMessage = {
            ...message,
            id: uuidv4(),
            timestamp: message.timestamp ?? Date.now(),
          };

          useConsoleStore.getState().addFrame({
            timestamp: next.timestamp,
            protocol: 'kafka',
            direction:
              next.direction === 'sent' ? 'out' : next.direction === 'received' ? 'in' : 'system',
            connectionId,
            label: next.topic,
            payload: next.value ?? '',
          });

          return {
            connections: {
              ...state.connections,
              [connectionId]: { ...conn, messages: capMessages(conn.messages, next) },
            },
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
            (m) =>
              m.value.toLowerCase().includes(q) ||
              (m.key?.toLowerCase().includes(q) ?? false) ||
              m.topic.toLowerCase().includes(q)
          );
        }
        return messages;
      },
    }),
    createPersistedStore<KafkaState>({
      store: 'kafkaConnections',
      persistName: 'kafka-storage',
      version: 1,
      steps: [],
      partialize: (state) => ({
        connections: Object.fromEntries(
          Object.entries(state.connections).map(([id, conn]) => [
            id,
            {
              ...conn,
              // Never persist runtime state — and never persist plaintext secrets.
              // The renderer keeps sentinels; resolution happens at IPC time.
              status: 'disconnected' as const,
              messages: [] as KafkaMessage[],
              auth: redactSecrets(conn.auth),
              registry: conn.registry ? redactRegistry(conn.registry) : undefined,
              consumer: { ...conn.consumer, status: 'idle' as const },
            },
          ])
        ),
        activeConnectionId: state.activeConnectionId,
        connectionByTabId: state.connectionByTabId,
      }),
    })
  )
);

function redactSecrets(auth: KafkaAuth): KafkaAuth {
  const next: KafkaAuth = { securityProtocol: auth.securityProtocol };
  if (auth.sasl) {
    next.sasl = {
      mechanism: auth.sasl.mechanism,
      username: auth.sasl.username,
      password: auth.sasl.password ? KAFKA_SECRET_SENTINEL : '',
    };
  }
  if (auth.tls) {
    const tls: KafkaTls = {};
    if (auth.tls.caPath !== undefined) tls.caPath = auth.tls.caPath;
    if (auth.tls.certPath !== undefined) tls.certPath = auth.tls.certPath;
    if (auth.tls.keyPath !== undefined) tls.keyPath = auth.tls.keyPath;
    if (auth.tls.passphrase) tls.passphrase = KAFKA_SECRET_SENTINEL;
    if (auth.tls.rejectUnauthorized !== undefined)
      tls.rejectUnauthorized = auth.tls.rejectUnauthorized;
    next.tls = tls;
  }
  return next;
}

function redactRegistry(registry: KafkaRegistry): KafkaRegistry {
  if (!registry.auth) return { url: registry.url };
  const auth: NonNullable<KafkaRegistry['auth']> = {};
  if (registry.auth.username !== undefined) auth.username = registry.auth.username;
  if (registry.auth.password) auth.password = KAFKA_SECRET_SENTINEL;
  if (registry.auth.token) auth.token = KAFKA_SECRET_SENTINEL;
  return { url: registry.url, auth };
}
