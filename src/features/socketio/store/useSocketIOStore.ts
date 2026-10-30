import { v4 as uuidv4 } from 'uuid';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createPersistedStore } from '@/lib/shared/persistence/createPersistedStore';
import { clearComposerDrafts } from '@/lib/shared/streaming/composerDrafts';
import {
  migrateConnectionTemplates,
  type SocketIOEmitTemplate,
  socketIOTemplateSchema,
} from '@/lib/shared/streaming/messageTemplates';
import { type FrameDirection, useConsoleStore } from '@/store/useConsoleStore';
import { emitStreamEvent } from '@/store/useStreamTimelineStore';
import type { KeyValue } from '@/types';
import { filterSocketIOEvents } from '../lib/eventFilter';

export type SocketIOStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
export type SocketIOEventDirection = 'sent' | 'received' | 'system' | 'ack';
export type SocketIOTransport = 'websocket' | 'polling';
export type SocketIOAuthMode = 'kv' | 'json';

/** Per-emit modifiers applied to every emit from the composer (SIO-5). */
export interface SocketIOEmitOptions {
  /** `socket.volatile` — drop the emit if the transport isn't writable. */
  volatile: boolean;
  /** `false` → `socket.compress(false)`. */
  compress: boolean;
  /** How long to wait for an ack before marking it timed out. */
  ackTimeoutMs: number;
}

export interface SocketIOEvent {
  id: string;
  direction: SocketIOEventDirection;
  eventName: string;
  args: unknown[];
  /** Set when this row represents an outbound emit awaiting ack, or the resolved ack itself. */
  ackId?: string;
  /** When direction === 'ack', whether the ack arrived ('ok') or timed out ('timeout'). */
  ackStatus?: 'ok' | 'timeout';
  /**
   * Set on a received event whose server emit asked for an acknowledgement
   * (SIO-1). The callback itself stays in the manager / Electron main —
   * functions never enter the store.
   */
  serverAckId?: string;
  /** True once the user has answered the server-requested ack. */
  serverAckReplied?: boolean;
  timestamp: number;
}

export interface SocketIOConnection {
  id: string;
  url: string;
  namespace: string;
  path: string;
  auth: KeyValue[];
  /** `kv` sends `auth` as a flat string map; `json` sends `authJson` parsed (SIO-4). */
  authMode: SocketIOAuthMode;
  /** Handshake auth as JSON, stored unresolved — `{{var}}` is substituted at connect time. */
  authJson: string;
  query: KeyValue[];
  extraHeaders: KeyValue[];
  transports: SocketIOTransport[];
  autoReconnect: boolean;
  reconnectionAttempts: number;
  reconnectionDelay: number;
  reconnectionDelayMax: number;
  randomizationFactor: number;
  timeout: number;
  forceNew: boolean;
  emitOptions: SocketIOEmitOptions;
  status: SocketIOStatus;
  reconnectAttemptCount: number;
  events: SocketIOEvent[];
  subscribedEvents: string[];
  /** Saved emits, stored unresolved — `{{var}}` is substituted at emit time. */
  templates: SocketIOEmitTemplate[];
  createdAt: number;
  lastConnectedAt?: number;
}

export type SocketIOEventFilter = SocketIOEventDirection | 'all';

interface SocketIOState {
  connections: Record<string, SocketIOConnection>;
  activeConnectionId: string | null;
  /** Workspace-tab → connection mapping (mirrors useWebSocketStore). */
  connectionByTabId: Record<string, string>;

  eventFilter: SocketIOEventFilter;
  searchQuery: string;

  // Lifecycle
  createConnection: (url?: string) => string;
  removeConnection: (id: string) => void;
  setActiveConnection: (id: string | null) => void;
  /** Idempotent — returns the existing tab connection or creates one. */
  ensureConnectionForTab: (tabId: string, url?: string) => string;
  /** Disconnects and removes the connection bound to `tabId`. */
  cleanupConnectionForTab: (tabId: string) => void;

  // Connection state
  updateConnectionStatus: (id: string, status: SocketIOStatus) => void;
  updateConnectionField: <K extends keyof SocketIOConnection>(
    id: string,
    field: K,
    value: SocketIOConnection[K]
  ) => void;
  setReconnectAttemptCount: (id: string, n: number) => void;
  setLastConnectedAt: (id: string, ts: number) => void;

  // Events
  addEvent: (connectionId: string, event: Omit<SocketIOEvent, 'id' | 'timestamp'>) => void;
  resolveAck: (
    connectionId: string,
    ackId: string,
    args: unknown[],
    status: 'ok' | 'timeout'
  ) => void;
  markServerAckReplied: (connectionId: string, serverAckId: string) => void;
  clearEvents: (connectionId: string) => void;

  // KeyValue helpers
  /** Replace a whole key/value list (the key/value table drives edits through this). */
  setKv: (
    connectionId: string,
    field: 'auth' | 'query' | 'extraHeaders',
    items: KeyValue[]
  ) => void;

  // Subscriptions
  addSubscribedEvent: (connectionId: string, eventName: string) => void;
  removeSubscribedEvent: (connectionId: string, eventName: string) => void;

  // Filtering
  setEventFilter: (filter: SocketIOEventFilter) => void;
  setSearchQuery: (q: string) => void;

  // Computed
  getActiveConnection: () => SocketIOConnection | null;
  getFilteredEvents: (connectionId: string) => SocketIOEvent[];
}

const DEFAULT_RECONNECT_ATTEMPTS = 5;
const DEFAULT_RECONNECT_DELAY = 1_000;
const DEFAULT_RECONNECT_DELAY_MAX = 5_000;
const DEFAULT_RANDOMIZATION_FACTOR = 0.5;
const DEFAULT_HANDSHAKE_TIMEOUT = 20_000;
export const DEFAULT_ACK_TIMEOUT_MS = 15_000;
const MAX_EVENTS_PER_CONNECTION = 1000;

/** Defaults for fields added after v2 — applied to new and migrated connections. */
export const SOCKETIO_CONNECTION_OPTION_DEFAULTS = {
  authMode: 'kv' as SocketIOAuthMode,
  authJson: '{}',
  reconnectionDelayMax: DEFAULT_RECONNECT_DELAY_MAX,
  randomizationFactor: DEFAULT_RANDOMIZATION_FACTOR,
  emitOptions: { volatile: false, compress: true, ackTimeoutMs: DEFAULT_ACK_TIMEOUT_MS },
};

/** v2 → v3: fill the connection options / auth mode / emit options added for #847. */
export function migrateConnectionOptions(state: unknown): unknown {
  if (!state || typeof state !== 'object') return state;
  const record = state as { connections?: unknown };
  if (!record.connections || typeof record.connections !== 'object') return state;
  if (Array.isArray(record.connections)) return { ...record, connections: {} };
  const d = SOCKETIO_CONNECTION_OPTION_DEFAULTS;
  const connections = Object.fromEntries(
    Object.entries(record.connections as Record<string, unknown>).map(([id, conn]) => {
      if (!conn || typeof conn !== 'object') return [id, conn];
      const c = conn as Record<string, unknown>;
      return [
        id,
        {
          ...c,
          authMode: c.authMode === 'json' ? 'json' : d.authMode,
          authJson: typeof c.authJson === 'string' ? c.authJson : d.authJson,
          reconnectionDelayMax:
            typeof c.reconnectionDelayMax === 'number'
              ? c.reconnectionDelayMax
              : d.reconnectionDelayMax,
          randomizationFactor:
            typeof c.randomizationFactor === 'number'
              ? c.randomizationFactor
              : d.randomizationFactor,
          emitOptions:
            c.emitOptions && typeof c.emitOptions === 'object'
              ? { ...d.emitOptions, ...(c.emitOptions as object) }
              : { ...d.emitOptions },
        },
      ];
    })
  );
  return { ...record, connections };
}

function emptyConnection(id: string, url: string): SocketIOConnection {
  return {
    id,
    url,
    namespace: '/',
    path: '/socket.io',
    auth: [],
    authMode: SOCKETIO_CONNECTION_OPTION_DEFAULTS.authMode,
    authJson: SOCKETIO_CONNECTION_OPTION_DEFAULTS.authJson,
    query: [],
    extraHeaders: [],
    transports: ['websocket', 'polling'],
    autoReconnect: true,
    reconnectionAttempts: DEFAULT_RECONNECT_ATTEMPTS,
    reconnectionDelay: DEFAULT_RECONNECT_DELAY,
    reconnectionDelayMax: DEFAULT_RECONNECT_DELAY_MAX,
    randomizationFactor: DEFAULT_RANDOMIZATION_FACTOR,
    timeout: DEFAULT_HANDSHAKE_TIMEOUT,
    forceNew: false,
    emitOptions: { ...SOCKETIO_CONNECTION_OPTION_DEFAULTS.emitOptions },
    status: 'disconnected',
    reconnectAttemptCount: 0,
    events: [],
    subscribedEvents: [],
    templates: [],
    createdAt: Date.now(),
  };
}

export const useSocketIOStore = create<SocketIOState>()(
  persist(
    (set, get) => ({
      connections: {},
      activeConnectionId: null,
      connectionByTabId: {},
      eventFilter: 'all',
      searchQuery: '',

      createConnection: (url = '') => {
        const id = uuidv4();
        const connection = emptyConnection(id, url);
        set((state) => ({
          connections: { ...state.connections, [id]: connection },
          activeConnectionId: id,
        }));
        return id;
      },

      removeConnection: (id) => {
        clearComposerDrafts(id);
        set((state) => {
          const { [id]: _, ...rest } = state.connections;
          const nextMap = Object.fromEntries(
            Object.entries(state.connectionByTabId).filter(([, cid]) => cid !== id)
          );
          return {
            connections: rest,
            connectionByTabId: nextMap,
            activeConnectionId: state.activeConnectionId === id ? null : state.activeConnectionId,
          };
        });
      },

      setActiveConnection: (id) => set({ activeConnectionId: id }),

      ensureConnectionForTab: (tabId, url = '') => {
        const existing = get().connectionByTabId[tabId];
        if (existing && get().connections[existing]) {
          if (get().activeConnectionId !== existing) set({ activeConnectionId: existing });
          return existing;
        }
        const id = get().createConnection(url);
        set((state) => ({
          connectionByTabId: { ...state.connectionByTabId, [tabId]: id },
          activeConnectionId: id,
        }));
        return id;
      },

      cleanupConnectionForTab: (tabId) => {
        const connectionId = get().connectionByTabId[tabId];
        if (!connectionId) return;
        clearComposerDrafts(connectionId);
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

      updateConnectionStatus: (id, status) =>
        set((state) => {
          const c = state.connections[id];
          if (!c || c.status === status) return state;
          return {
            connections: { ...state.connections, [id]: { ...c, status } },
          };
        }),

      updateConnectionField: (id, field, value) =>
        set((state) => {
          const c = state.connections[id];
          if (!c || c[field] === value) return state;
          return {
            connections: { ...state.connections, [id]: { ...c, [field]: value } },
          };
        }),

      setReconnectAttemptCount: (id, n) =>
        set((state) => {
          const c = state.connections[id];
          if (!c || c.reconnectAttemptCount === n) return state;
          return {
            connections: { ...state.connections, [id]: { ...c, reconnectAttemptCount: n } },
          };
        }),

      setLastConnectedAt: (id, ts) =>
        set((state) => {
          const c = state.connections[id];
          if (!c) return state;
          return {
            connections: { ...state.connections, [id]: { ...c, lastConnectedAt: ts } },
          };
        }),

      addEvent: (connectionId, event) =>
        set((state) => {
          const c = state.connections[connectionId];
          if (!c) return state;
          const newEvent: SocketIOEvent = {
            id: uuidv4(),
            timestamp: Date.now(),
            ...event,
          };
          let events = [...c.events, newEvent];
          if (events.length > MAX_EVENTS_PER_CONNECTION) {
            events = events.slice(-MAX_EVENTS_PER_CONNECTION);
          }

          const frameDirection: FrameDirection =
            newEvent.direction === 'sent'
              ? 'out'
              : newEvent.direction === 'received' || newEvent.direction === 'ack'
                ? 'in'
                : 'system';
          useConsoleStore.getState().addFrame({
            timestamp: newEvent.timestamp,
            protocol: 'socketio',
            direction: frameDirection,
            connectionId,
            label: newEvent.eventName,
            payload: JSON.stringify(newEvent.args),
          });
          emitStreamEvent({
            ts: newEvent.timestamp,
            protocol: 'socketio',
            connectionId,
            direction: frameDirection,
            kind: newEvent.direction === 'ack' ? 'ack' : undefined,
            label: newEvent.eventName,
            payload: JSON.stringify(newEvent.args),
            meta: { ackId: newEvent.ackId, namespace: c.namespace },
          });

          return {
            connections: { ...state.connections, [connectionId]: { ...c, events } },
          };
        }),

      resolveAck: (connectionId, ackId, args, status) =>
        set((state) => {
          const c = state.connections[connectionId];
          if (!c) return state;
          // Mark the original 'sent' row resolved and append a separate 'ack' row.
          const events = c.events.map((e) =>
            e.ackId === ackId && e.direction === 'sent' ? { ...e, ackStatus: status } : e
          );
          const ackRow: SocketIOEvent = {
            id: uuidv4(),
            direction: 'ack',
            eventName: status === 'timeout' ? '<ack timeout>' : '<ack>',
            args,
            ackId,
            ackStatus: status,
            timestamp: Date.now(),
          };
          events.push(ackRow);
          // Ack rows reach the unified Timeline too (timeouts as errors).
          emitStreamEvent({
            ts: ackRow.timestamp,
            protocol: 'socketio',
            connectionId,
            direction: 'in',
            kind: status === 'timeout' ? 'error' : 'ack',
            label: ackRow.eventName,
            payload: JSON.stringify(args),
            meta: { ackId, namespace: c.namespace },
          });
          return {
            connections: { ...state.connections, [connectionId]: { ...c, events } },
          };
        }),

      markServerAckReplied: (connectionId, serverAckId) =>
        set((state) => {
          const c = state.connections[connectionId];
          if (!c) return state;
          return {
            connections: {
              ...state.connections,
              [connectionId]: {
                ...c,
                events: c.events.map((e) =>
                  e.serverAckId === serverAckId ? { ...e, serverAckReplied: true } : e
                ),
              },
            },
          };
        }),

      clearEvents: (connectionId) =>
        set((state) => {
          const c = state.connections[connectionId];
          if (!c) return state;
          return {
            connections: { ...state.connections, [connectionId]: { ...c, events: [] } },
          };
        }),

      setKv: (connectionId, field, items) =>
        set((state) => {
          const c = state.connections[connectionId];
          if (!c) return state;
          return {
            connections: { ...state.connections, [connectionId]: { ...c, [field]: items } },
          };
        }),

      addSubscribedEvent: (connectionId, eventName) =>
        set((state) => {
          const c = state.connections[connectionId];
          if (!c) return state;
          if (c.subscribedEvents.includes(eventName)) return state;
          return {
            connections: {
              ...state.connections,
              [connectionId]: { ...c, subscribedEvents: [...c.subscribedEvents, eventName] },
            },
          };
        }),

      removeSubscribedEvent: (connectionId, eventName) =>
        set((state) => {
          const c = state.connections[connectionId];
          if (!c) return state;
          return {
            connections: {
              ...state.connections,
              [connectionId]: {
                ...c,
                subscribedEvents: c.subscribedEvents.filter((e) => e !== eventName),
              },
            },
          };
        }),

      setEventFilter: (filter) => set({ eventFilter: filter }),
      setSearchQuery: (q) => set({ searchQuery: q }),

      getActiveConnection: () => {
        const { connections, activeConnectionId } = get();
        return activeConnectionId ? (connections[activeConnectionId] ?? null) : null;
      },

      getFilteredEvents: (connectionId) => {
        const { connections, eventFilter, searchQuery } = get();
        const c = connections[connectionId];
        if (!c) return [];
        return filterSocketIOEvents(c.events, eventFilter, searchQuery);
      },
    }),
    createPersistedStore<SocketIOState>({
      store: 'socketioConnections',
      persistName: 'socketio-storage',
      version: 3,
      steps: [
        {
          name: 'add-emit-templates',
          fromVersion: 1,
          apply: (state) => ({
            state: migrateConnectionTemplates(state, socketIOTemplateSchema),
          }),
        },
        {
          name: 'add-connection-options',
          fromVersion: 2,
          apply: (state) => ({ state: migrateConnectionOptions(state) }),
        },
      ],
      partialize: (state) => ({
        connections: Object.fromEntries(
          Object.entries(state.connections).map(([id, c]) => [
            id,
            {
              ...c,
              status: 'disconnected' as const,
              reconnectAttemptCount: 0,
              events: [], // Don't persist the event log
            },
          ])
        ),
        activeConnectionId: state.activeConnectionId,
        connectionByTabId: state.connectionByTabId,
      }),
    })
  )
);
