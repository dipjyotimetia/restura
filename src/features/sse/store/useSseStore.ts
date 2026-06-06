import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { KeyValue } from '@/types';
import { v4 as uuidv4 } from 'uuid';
import { dexieStorageAdapters } from '@/lib/shared/dexie-storage';
import { useConsoleStore } from '@/store/useConsoleStore';

export type SseConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/** A single received event, normalized for display */
export interface SseEventRecord {
  id: string;
  /** Server event name (defaults to 'message') */
  event: string;
  data: string;
  lastEventId?: string;
  retry?: number;
  timestamp: number;
}

/** A system message (connect / disconnect / error) for the UI log */
export interface SseSystemMessage {
  id: string;
  kind: 'system';
  message: string;
  timestamp: number;
}

export type SseLogEntry = ({ kind: 'event' } & SseEventRecord) | SseSystemMessage;

export interface SseConnection {
  id: string;
  url: string;
  status: SseConnectionStatus;
  log: SseLogEntry[];
  headers: KeyValue[];
  /** UI-side filter on event names; empty = include all */
  eventFilter: string[];
  /** Reconnect using Last-Event-ID on disconnect */
  reconnectOnResume: boolean;
  /** Last-Event-ID seen, surfaced in the UI and used by the manager on reconnect */
  lastEventId?: string;
  reconnectAttempts: number;
  maxReconnectAttempts: number;
  reconnectDelay: number;
  createdAt: number;
  lastConnectedAt?: number;
}

interface SseState {
  connections: Record<string, SseConnection>;
  activeConnectionId: string | null;

  searchQuery: string;
  eventNameFilter: string; // 'all' | specific event name

  createConnection: (url?: string) => string;
  removeConnection: (id: string) => void;
  setActiveConnection: (id: string | null) => void;

  updateConnectionStatus: (id: string, status: SseConnectionStatus) => void;
  updateConnectionUrl: (id: string, url: string) => void;
  setReconnectAttempts: (id: string, attempts: number) => void;
  setReconnectOnResume: (id: string, enabled: boolean) => void;
  setLastEventId: (id: string, lastEventId: string | undefined) => void;
  setLastConnectedAt: (id: string, ts: number) => void;

  appendEvent: (connectionId: string, event: Omit<SseEventRecord, 'id' | 'timestamp'>) => void;
  appendSystem: (connectionId: string, message: string) => void;
  clearLog: (connectionId: string) => void;

  addHeader: (connectionId: string) => void;
  updateHeader: (connectionId: string, headerId: string, updates: Partial<KeyValue>) => void;
  removeHeader: (connectionId: string, headerId: string) => void;

  setSearchQuery: (q: string) => void;
  setEventNameFilter: (f: string) => void;

  getActiveConnection: () => SseConnection | null;
  getFilteredLog: (connectionId: string) => SseLogEntry[];
}

const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const DEFAULT_RECONNECT_DELAY = 1000;
const MAX_LOG_PER_CONNECTION = 1000;

export const useSseStore = create<SseState>()(
  persist(
    (set, get) => ({
      connections: {},
      activeConnectionId: null,
      searchQuery: '',
      eventNameFilter: 'all',

      createConnection: (url = '') => {
        const id = uuidv4();
        const conn: SseConnection = {
          id,
          url,
          status: 'disconnected',
          log: [],
          headers: [],
          eventFilter: [],
          reconnectOnResume: true,
          reconnectAttempts: 0,
          maxReconnectAttempts: DEFAULT_MAX_RECONNECT_ATTEMPTS,
          reconnectDelay: DEFAULT_RECONNECT_DELAY,
          createdAt: Date.now(),
        };
        set((s) => ({
          connections: { ...s.connections, [id]: conn },
          activeConnectionId: id,
        }));
        return id;
      },

      removeConnection: (id) =>
        set((s) => {
          const { [id]: _, ...rest } = s.connections;
          return {
            connections: rest,
            activeConnectionId: s.activeConnectionId === id ? null : s.activeConnectionId,
          };
        }),

      setActiveConnection: (id) => set({ activeConnectionId: id }),

      updateConnectionStatus: (id, status) =>
        set((s) => {
          const c = s.connections[id];
          if (!c) return s;
          return { connections: { ...s.connections, [id]: { ...c, status } } };
        }),

      updateConnectionUrl: (id, url) =>
        set((s) => {
          const c = s.connections[id];
          if (!c) return s;
          return { connections: { ...s.connections, [id]: { ...c, url } } };
        }),

      setReconnectAttempts: (id, attempts) =>
        set((s) => {
          const c = s.connections[id];
          if (!c) return s;
          return { connections: { ...s.connections, [id]: { ...c, reconnectAttempts: attempts } } };
        }),

      setReconnectOnResume: (id, enabled) =>
        set((s) => {
          const c = s.connections[id];
          if (!c) return s;
          return { connections: { ...s.connections, [id]: { ...c, reconnectOnResume: enabled } } };
        }),

      setLastEventId: (id, lastEventId) =>
        set((s) => {
          const c = s.connections[id];
          if (!c) return s;
          return { connections: { ...s.connections, [id]: { ...c, lastEventId } } };
        }),

      setLastConnectedAt: (id, ts) =>
        set((s) => {
          const c = s.connections[id];
          if (!c) return s;
          return { connections: { ...s.connections, [id]: { ...c, lastConnectedAt: ts } } };
        }),

      appendEvent: (connectionId, event) =>
        set((s) => {
          const c = s.connections[connectionId];
          if (!c) return s;
          const record: SseLogEntry = {
            kind: 'event',
            id: uuidv4(),
            event: event.event,
            data: event.data,
            ...(event.lastEventId !== undefined ? { lastEventId: event.lastEventId } : {}),
            ...(event.retry !== undefined ? { retry: event.retry } : {}),
            timestamp: Date.now(),
          };
          let log = [...c.log, record];
          if (log.length > MAX_LOG_PER_CONNECTION) log = log.slice(-MAX_LOG_PER_CONNECTION);
          // Mirror to the unified console so SSE events show up alongside
          // WS/Kafka frames in the Frames tab (same pattern as useWebSocketStore).
          useConsoleStore.getState().addFrame({
            timestamp: record.timestamp,
            protocol: 'sse',
            direction: 'in',
            connectionId,
            ...(event.event ? { label: event.event } : {}),
            payload: event.data,
            bytes: new TextEncoder().encode(event.data).length,
          });
          // Persist most-recent lastEventId for resume
          const next: SseConnection = {
            ...c,
            log,
            ...(event.lastEventId !== undefined ? { lastEventId: event.lastEventId } : {}),
          };
          return { connections: { ...s.connections, [connectionId]: next } };
        }),

      appendSystem: (connectionId, message) =>
        set((s) => {
          const c = s.connections[connectionId];
          if (!c) return s;
          const entry: SseLogEntry = {
            kind: 'system',
            id: uuidv4(),
            message,
            timestamp: Date.now(),
          };
          let log = [...c.log, entry];
          if (log.length > MAX_LOG_PER_CONNECTION) log = log.slice(-MAX_LOG_PER_CONNECTION);
          useConsoleStore.getState().addFrame({
            timestamp: entry.timestamp,
            protocol: 'sse',
            direction: 'system',
            connectionId,
            payload: message,
          });
          return { connections: { ...s.connections, [connectionId]: { ...c, log } } };
        }),

      clearLog: (connectionId) =>
        set((s) => {
          const c = s.connections[connectionId];
          if (!c) return s;
          return { connections: { ...s.connections, [connectionId]: { ...c, log: [] } } };
        }),

      addHeader: (connectionId) =>
        set((s) => {
          const c = s.connections[connectionId];
          if (!c) return s;
          const h: KeyValue = { id: uuidv4(), key: '', value: '', enabled: true };
          return {
            connections: { ...s.connections, [connectionId]: { ...c, headers: [...c.headers, h] } },
          };
        }),

      updateHeader: (connectionId, headerId, updates) =>
        set((s) => {
          const c = s.connections[connectionId];
          if (!c) return s;
          return {
            connections: {
              ...s.connections,
              [connectionId]: {
                ...c,
                headers: c.headers.map((h) => (h.id === headerId ? { ...h, ...updates } : h)),
              },
            },
          };
        }),

      removeHeader: (connectionId, headerId) =>
        set((s) => {
          const c = s.connections[connectionId];
          if (!c) return s;
          return {
            connections: {
              ...s.connections,
              [connectionId]: { ...c, headers: c.headers.filter((h) => h.id !== headerId) },
            },
          };
        }),

      setSearchQuery: (q) => set({ searchQuery: q }),
      setEventNameFilter: (f) => set({ eventNameFilter: f }),

      getActiveConnection: () => {
        const { connections, activeConnectionId } = get();
        return activeConnectionId ? (connections[activeConnectionId] ?? null) : null;
      },

      getFilteredLog: (connectionId) => {
        const { connections, searchQuery, eventNameFilter } = get();
        const c = connections[connectionId];
        if (!c) return [];
        let log = c.log;
        if (eventNameFilter !== 'all') {
          log = log.filter((e) => e.kind === 'event' && e.event === eventNameFilter);
        }
        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase();
          log = log.filter((e) =>
            e.kind === 'event'
              ? e.data.toLowerCase().includes(q) || e.event.toLowerCase().includes(q)
              : e.message.toLowerCase().includes(q)
          );
        }
        return log;
      },
    }),
    {
      name: 'sse-storage',
      storage: dexieStorageAdapters.sseConnections(),
      partialize: (state) => ({
        connections: Object.fromEntries(
          Object.entries(state.connections).map(([id, conn]) => [
            id,
            {
              ...conn,
              status: 'disconnected' as const,
              log: [],
              reconnectAttempts: 0,
            },
          ])
        ),
        activeConnectionId: state.activeConnectionId,
      }),
    }
  )
);
