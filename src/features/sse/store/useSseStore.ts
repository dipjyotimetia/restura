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
import { emitStreamEvent } from '@/store/useStreamTimelineStore';

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
  /** Entries evicted by the rolling log cap since the last clear (runtime only). */
  droppedCount?: number;
}

interface SseState {
  connections: Record<string, SseConnection>;
  /** Transient aggregates for rendering active streams without rescanning their logs. */
  summaries: Record<string, SseStreamSummary>;
  activeConnectionId: string | null;
  /** Each SSE tab owns its own stream, so background tabs keep streaming. */
  connectionByTabId: Record<string, string>;

  searchQuery: string;

  createConnection: () => string;
  removeConnection: (id: string) => void;
  setActiveConnection: (id: string | null) => void;
  /** Returns the tab's connection, creating it on first use, and marks it active. */
  ensureConnectionForTab: (tabId: string) => string;
  /** Removes the tab's connection (the caller disconnects the stream first). */
  cleanupConnectionForTab: (tabId: string) => void;

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

function capLog(
  log: SseLogEntry[],
  dropped: number | undefined
): { log: SseLogEntry[]; droppedCount: number; trimmed: boolean } {
  const over = log.length - MAX_LOG_PER_CONNECTION;
  if (over <= 0) return { log, droppedCount: dropped ?? 0, trimmed: false };
  return { log: log.slice(over), droppedCount: (dropped ?? 0) + over, trimmed: true };
}

/** True when some tab still maps to this connection id. */
export function isMappedConnection(
  connectionByTabId: Readonly<Record<string, string>>,
  connectionId: string
): boolean {
  return Object.values(connectionByTabId).includes(connectionId);
}

export const useSseStore = create<SseState>()(
  persist(
    (set, get) => ({
      connections: {},
      summaries: {},
      activeConnectionId: null,
      connectionByTabId: {},
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
            connectionByTabId: Object.fromEntries(
              Object.entries(s.connectionByTabId).filter(([, cid]) => cid !== id)
            ),
            activeConnectionId: s.activeConnectionId === id ? null : s.activeConnectionId,
          };
        }),

      setActiveConnection: (id) => set({ activeConnectionId: id }),

      ensureConnectionForTab: (tabId) => {
        const existing = get().connectionByTabId[tabId];
        if (existing && get().connections[existing]) {
          if (get().activeConnectionId !== existing) set({ activeConnectionId: existing });
          return existing;
        }
        const id = get().createConnection();
        set((s) => ({ connectionByTabId: { ...s.connectionByTabId, [tabId]: id } }));
        return id;
      },

      cleanupConnectionForTab: (tabId) => {
        const connectionId = get().connectionByTabId[tabId];
        if (!connectionId) return;
        set((s) => {
          const { [connectionId]: _drop, ...connections } = s.connections;
          const { [connectionId]: _dropSummary, ...summaries } = s.summaries;
          const { [tabId]: _dropTab, ...connectionByTabId } = s.connectionByTabId;
          return {
            connections,
            summaries,
            connectionByTabId,
            activeConnectionId: s.activeConnectionId === connectionId ? null : s.activeConnectionId,
          };
        });
      },

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
          const {
            log,
            droppedCount,
            trimmed: logWasTrimmed,
          } = capLog([...c.log, record], c.droppedCount);
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
          emitStreamEvent({
            ts: record.timestamp,
            protocol: 'sse',
            connectionId,
            direction: 'in',
            label: event.event,
            payload: event.data,
            meta: { lastEventId: event.lastEventId, retry: event.retry },
          });
          // Persist most-recent lastEventId for resume
          const next: SseConnection = {
            ...c,
            log,
            droppedCount,
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
          const { log, droppedCount } = capLog([...c.log, entry], c.droppedCount);
          useConsoleStore.getState().addFrame({
            timestamp: entry.timestamp,
            protocol: 'sse',
            direction: 'system',
            connectionId,
            payload: message,
          });
          emitStreamEvent({
            ts: entry.timestamp,
            protocol: 'sse',
            connectionId,
            direction: 'system',
            payload: message,
          });
          return { connections: { ...s.connections, [connectionId]: { ...c, log, droppedCount } } };
        }),

      clearLog: (connectionId) =>
        set((s) => {
          const c = s.connections[connectionId];
          if (!c) return s;
          return {
            connections: { ...s.connections, [connectionId]: { ...c, log: [], droppedCount: 0 } },
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
        // Only connections a tab still owns: rows from the old single-connection
        // model (never mapped to a tab) are shed on the next write.
        connections: Object.fromEntries(
          Object.entries(state.connections)
            .filter(([id]) => isMappedConnection(state.connectionByTabId, id))
            .map(([id, conn]) => [
              id,
              {
                // Explicit pick (not a spread) so request config persisted by
                // older versions (url/headers/auth…) is shed on the next write.
                id: conn.id,
                status: 'disconnected' as const,
                log: [],
                // No lastEventId: it only resumes reconnects within one session.
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
        connectionByTabId: state.connectionByTabId,
      }),
      // Pre-#873 blobs carried url/headers here; hand them to blank SSE tabs.
      onRehydrate: (state) => migrateLegacySseConfig(state),
    })
  )
);
