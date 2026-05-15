import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { v4 as uuidv4 } from 'uuid';
import { dexieStorageAdapters } from '@/lib/shared/dexie-storage';

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
  consumer: KafkaConsumerState;
  messages: KafkaMessage[];
  createdAt: number;
  lastConnectedAt?: number;
}

interface KafkaState {
  connections: Record<string, KafkaConnection>;
  activeConnectionId: string | null;
  messageFilter: KafkaMessageDirection | 'all';
  searchQuery: string;

  // Lifecycle
  createConnection: (init?: Partial<Pick<KafkaConnection, 'name' | 'bootstrapBrokers' | 'clientId'>>) => string;
  removeConnection: (id: string) => void;
  setActiveConnection: (id: string | null) => void;

  // Connection metadata
  updateConnection: (
    id: string,
    patch: Partial<Omit<KafkaConnection, 'id' | 'createdAt' | 'messages' | 'consumer'>>
  ) => void;
  updateAuth: (id: string, auth: KafkaAuth) => void;
  updateConsumer: (id: string, patch: Partial<KafkaConsumerState>) => void;
  updateStatus: (id: string, status: KafkaConnection['status']) => void;
  setLastConnectedAt: (id: string, ts: number) => void;

  // Messages
  addMessage: (connectionId: string, message: Omit<KafkaMessage, 'id' | 'timestamp'> & { timestamp?: number }) => void;
  clearMessages: (connectionId: string) => void;

  // Filter
  setMessageFilter: (filter: KafkaMessageDirection | 'all') => void;
  setSearchQuery: (q: string) => void;

  // Selectors
  getActiveConnection: () => KafkaConnection | null;
  getFilteredMessages: (connectionId: string) => KafkaMessage[];
}

const MAX_MESSAGES_PER_CONNECTION = 1000;

function makeDefaultConnection(init?: Partial<Pick<KafkaConnection, 'name' | 'bootstrapBrokers' | 'clientId'>>): KafkaConnection {
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

      removeConnection: (id) =>
        set((state) => {
          const { [id]: _removed, ...rest } = state.connections;
          return {
            connections: rest,
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
          return { connections: { ...state.connections, [id]: { ...conn, status } } };
        }),

      setLastConnectedAt: (id, ts) =>
        set((state) => {
          const conn = state.connections[id];
          if (!conn) return state;
          return { connections: { ...state.connections, [id]: { ...conn, lastConnectedAt: ts } } };
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
          let messages = [...conn.messages, next];
          if (messages.length > MAX_MESSAGES_PER_CONNECTION) {
            messages = messages.slice(-MAX_MESSAGES_PER_CONNECTION);
          }
          return {
            connections: { ...state.connections, [connectionId]: { ...conn, messages } },
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
        return activeConnectionId ? connections[activeConnectionId] ?? null : null;
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
    {
      name: 'kafka-storage',
      storage: dexieStorageAdapters.kafkaConnections(),
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
              consumer: { ...conn.consumer, status: 'idle' as const },
            },
          ])
        ),
        activeConnectionId: state.activeConnectionId,
      }),
    }
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
    next.tls = {
      caPath: auth.tls.caPath,
      certPath: auth.tls.certPath,
      keyPath: auth.tls.keyPath,
      passphrase: auth.tls.passphrase ? KAFKA_SECRET_SENTINEL : undefined,
      rejectUnauthorized: auth.tls.rejectUnauthorized,
    };
  }
  return next;
}
