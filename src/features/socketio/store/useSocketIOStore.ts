import { v4 as uuidv4 } from 'uuid';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { socketioManager } from '@/features/socketio/lib/socketioManager';
import { createPersistedStore } from '@/lib/shared/persistence/createPersistedStore';
import { type FrameDirection, useConsoleStore } from '@/store/useConsoleStore';
import type { KeyValue } from '@/types';

export type SocketIOStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
export type SocketIOEventDirection = 'sent' | 'received' | 'system' | 'ack';
export type SocketIOTransport = 'websocket' | 'polling';

export interface SocketIOEvent {
  id: string;
  direction: SocketIOEventDirection;
  eventName: string;
  args: unknown[];
  /** Set when this row represents an outbound emit awaiting ack, or the resolved ack itself. */
  ackId?: string;
  /** When direction === 'ack', whether the ack arrived ('ok') or timed out ('timeout'). */
  ackStatus?: 'ok' | 'timeout';
  timestamp: number;
}

export interface SocketIOConnection {
  id: string;
  url: string;
  namespace: string;
  path: string;
  auth: KeyValue[];
  query: KeyValue[];
  extraHeaders: KeyValue[];
  transports: SocketIOTransport[];
  autoReconnect: boolean;
  reconnectionAttempts: number;
  reconnectionDelay: number;
  timeout: number;
  forceNew: boolean;
  status: SocketIOStatus;
  reconnectAttemptCount: number;
  events: SocketIOEvent[];
  subscribedEvents: string[];
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
  clearEvents: (connectionId: string) => void;

  // KeyValue helpers
  addKv: (connectionId: string, field: 'auth' | 'query' | 'extraHeaders') => void;
  updateKv: (
    connectionId: string,
    field: 'auth' | 'query' | 'extraHeaders',
    kvId: string,
    updates: Partial<KeyValue>
  ) => void;
  removeKv: (connectionId: string, field: 'auth' | 'query' | 'extraHeaders', kvId: string) => void;

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
const DEFAULT_HANDSHAKE_TIMEOUT = 20_000;
const MAX_EVENTS_PER_CONNECTION = 1000;

function emptyConnection(id: string, url: string): SocketIOConnection {
  return {
    id,
    url,
    namespace: '/',
    path: '/socket.io',
    auth: [],
    query: [],
    extraHeaders: [],
    transports: ['websocket', 'polling'],
    autoReconnect: true,
    reconnectionAttempts: DEFAULT_RECONNECT_ATTEMPTS,
    reconnectionDelay: DEFAULT_RECONNECT_DELAY,
    timeout: DEFAULT_HANDSHAKE_TIMEOUT,
    forceNew: false,
    status: 'disconnected',
    reconnectAttemptCount: 0,
    events: [],
    subscribedEvents: [],
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

      removeConnection: (id) =>
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
        }),

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
        try {
          socketioManager.disconnect(connectionId);
        } catch {
          /* ignore — manager handles missing/already-closed sockets */
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
          return {
            connections: { ...state.connections, [connectionId]: { ...c, events } },
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

      addKv: (connectionId, field) =>
        set((state) => {
          const c = state.connections[connectionId];
          if (!c) return state;
          const kv: KeyValue = { id: uuidv4(), key: '', value: '', enabled: true };
          return {
            connections: {
              ...state.connections,
              [connectionId]: { ...c, [field]: [...c[field], kv] },
            },
          };
        }),

      updateKv: (connectionId, field, kvId, updates) =>
        set((state) => {
          const c = state.connections[connectionId];
          if (!c) return state;
          return {
            connections: {
              ...state.connections,
              [connectionId]: {
                ...c,
                [field]: c[field].map((kv) => (kv.id === kvId ? { ...kv, ...updates } : kv)),
              },
            },
          };
        }),

      removeKv: (connectionId, field, kvId) =>
        set((state) => {
          const c = state.connections[connectionId];
          if (!c) return state;
          return {
            connections: {
              ...state.connections,
              [connectionId]: {
                ...c,
                [field]: c[field].filter((kv) => kv.id !== kvId),
              },
            },
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
        let events = c.events;
        if (eventFilter !== 'all') {
          events = events.filter((e) => e.direction === eventFilter);
        }
        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase();
          events = events.filter((e) => {
            if (e.eventName.toLowerCase().includes(q)) return true;
            try {
              return JSON.stringify(e.args).toLowerCase().includes(q);
            } catch {
              return false;
            }
          });
        }
        return events;
      },
    }),
    createPersistedStore<SocketIOState>({
      store: 'socketioConnections',
      persistName: 'socketio-storage',
      version: 1,
      steps: [],
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
