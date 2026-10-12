import { v4 as uuidv4 } from 'uuid';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { migrateLegacySseConfig } from '@/features/sse/lib/legacySseConfig';
import {
  appendSseEventToSummary,
  createSseStreamSummary,
  rebuildSseStreamSummary,
  type SseStreamSummary,
} from '@/features/sse/lib/streamSummary';
import { createPersistedStore } from '@/lib/shared/persistence/createPersistedStore';
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

/**
 * Runtime state of the SSE stream. Request configuration (url, headers,
 * params, auth, event filter, reconnect-on-resume, scripts) is NOT kept here —
 * it lives on the active tab's `SseRequest` (`useRequestStore`), the single
 * source of truth that Save to Collection persists.
 */
export interface SseConnection {
  id: string;
  status: SseConnectionStatus;
  log: SseLogEntry[];
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
  /** Transient aggregates for rendering active streams without rescanning their logs. */
  summaries: Record<string, SseStreamSummary>;
  activeConnectionId: string | null;

  searchQuery: string;

  createConnection: () => string;
  removeConnection: (id: string) => void;
  setActiveConnection: (id: string | null) => void;

  updateConnectionStatus: (id: string, status: SseConnectionStatus) => void;
  setReconnectAttempts: (id: string, attempts: number) => void;
  setLastEventId: (id: string, lastEventId: string | undefined) => void;
  setLastConnectedAt: (id: string, ts: number) => void;

  appendEvent: (connectionId: string, event: Omit<SseEventRecord, 'id' | 'timestamp'>) => void;
  appendSystem: (connectionId: string, message: string) => void;
  clearLog: (connectionId: string) => void;

  setSearchQuery: (q: string) => void;

  getActiveConnection: () => SseConnection | null;
  /** `eventNameFilter` comes from the tab's request (`eventFilter[0]`); 'all' = no filter. */
  getFilteredLog: (connectionId: string, eventNameFilter?: string) => SseLogEntry[];
}

const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const DEFAULT_RECONNECT_DELAY = 1000;
const MAX_LOG_PER_CONNECTION = 1000;

export const useSseStore = create<SseState>()(
  persist(
    (set, get) => ({
      connections: {},
      summaries: {},
      activeConnectionId: null,
      searchQuery: '',

      createConnection: () => {
        const id = uuidv4();
        const conn: SseConnection = {
          id,
          status: 'disconnected',
          log: [],
          reconnectAttempts: 0,
          maxReconnectAttempts: DEFAULT_MAX_RECONNECT_ATTEMPTS,
          reconnectDelay: DEFAULT_RECONNECT_DELAY,
          createdAt: Date.now(),
        };
        set((s) => ({
          connections: { ...s.connections, [id]: conn },
          summaries: { ...s.summaries, [id]: createSseStreamSummary() },
          activeConnectionId: id,
        }));
        return id;
      },

      removeConnection: (id) =>
        set((s) => {
          const { [id]: _, ...rest } = s.connections;
          const { [id]: _summary, ...summaries } = s.summaries;
          return {
            connections: rest,
            summaries,
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

      setReconnectAttempts: (id, attempts) =>
        set((s) => {
          const c = s.connections[id];
          if (!c) return s;
          return { connections: { ...s.connections, [id]: { ...c, reconnectAttempts: attempts } } };
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
          const logWasTrimmed = log.length > MAX_LOG_PER_CONNECTION;
          if (logWasTrimmed) log = log.slice(-MAX_LOG_PER_CONNECTION);
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
          const summary = logWasTrimmed
            ? rebuildSseStreamSummary(log)
            : appendSseEventToSummary(
                s.summaries[connectionId] ?? createSseStreamSummary(),
                record
              );
          return {
            connections: { ...s.connections, [connectionId]: next },
            summaries: { ...s.summaries, [connectionId]: summary },
          };
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
          return {
            connections: { ...s.connections, [connectionId]: { ...c, log: [] } },
            summaries: { ...s.summaries, [connectionId]: createSseStreamSummary() },
          };
        }),

      setSearchQuery: (q) => set({ searchQuery: q }),

      getActiveConnection: () => {
        const { connections, activeConnectionId } = get();
        return activeConnectionId ? (connections[activeConnectionId] ?? null) : null;
      },

      getFilteredLog: (connectionId, eventNameFilter = 'all') => {
        const { connections, searchQuery } = get();
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
    createPersistedStore<SseState>({
      store: 'sseConnections',
      persistName: 'sse-storage',
      version: 1,
      steps: [],
      partialize: (state) => ({
        connections: Object.fromEntries(
          Object.entries(state.connections).map(([id, conn]) => [
            id,
            {
              // Explicit pick (not a spread) so request config persisted by
              // older versions (url/headers/auth…) is shed on the next write.
              id: conn.id,
              status: 'disconnected' as const,
              log: [],
              ...(conn.lastEventId !== undefined ? { lastEventId: conn.lastEventId } : {}),
              reconnectAttempts: 0,
              maxReconnectAttempts: conn.maxReconnectAttempts,
              reconnectDelay: conn.reconnectDelay,
              createdAt: conn.createdAt,
              ...(conn.lastConnectedAt !== undefined
                ? { lastConnectedAt: conn.lastConnectedAt }
                : {}),
            },
          ])
        ),
        activeConnectionId: state.activeConnectionId,
      }),
      // Pre-#873 blobs carried url/headers here; hand them to blank SSE tabs.
      onRehydrate: (state) => migrateLegacySseConfig(state),
    })
  )
);
