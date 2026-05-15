import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { v4 as uuidv4 } from 'uuid';
import { dexieStorageAdapters } from '@/lib/shared/dexie-storage';
import { ConsoleEntrySchema } from '@/lib/shared/store-validators';
import type { Response as ApiResponse, HttpMethod, HttpRequest, RequestBody } from '@/types';

export type ConsoleProtocol =
  | 'http'
  | 'grpc'
  | 'graphql'
  | 'mcp'
  | 'sse'
  | 'websocket'
  | 'kafka'
  | 'socketio';

export type ConsoleStatusFilter = 'all' | '2xx' | '3xx' | '4xx' | '5xx' | 'errored';

export interface ConsoleLog {
  type: 'log' | 'error' | 'warn' | 'info';
  message: string;
  timestamp: number;
}

export interface ConsoleTest {
  name: string;
  passed: boolean;
  error?: string;
}

export interface ConsoleEntry {
  id: string;
  timestamp: number;
  protocol?: ConsoleProtocol;
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
  };
  response: ApiResponse;
  scriptLogs?: ConsoleLog[];
  tests?: ConsoleTest[];
}

export type FrameProtocol = 'websocket' | 'socketio' | 'kafka';
export type FrameDirection = 'in' | 'out' | 'system';

export interface ConsoleFrame {
  id: string;
  timestamp: number;
  protocol: FrameProtocol;
  direction: FrameDirection;
  /** Connection or session identifier so frames from concurrent connections don't blur together. */
  connectionId?: string;
  /** Protocol-specific label (event name for Socket.IO, topic for Kafka, ws subprotocol/system tag for WS). */
  label?: string;
  /** Payload as a text preview — binary frames are pre-stringified by the caller. */
  payload: string;
  /** Optional payload byte size when known (so the UI can show "1.2 KB" without re-measuring). */
  bytes?: number;
}

// Live in-memory cap (entries kept while the app runs).
const MAX_ENTRIES = 100;
// How many of those entries to persist across reloads. Smaller window keeps
// IndexedDB writes cheap and rehydration fast — users rarely scroll past ~20.
const PERSIST_ENTRY_LIMIT = 50;
// Max bytes per persisted script-log message. Test scripts can dump huge
// objects; truncating before persist keeps the persisted blob bounded.
const PERSIST_LOG_MESSAGE_LIMIT = 4 * 1024;
// Max bytes per persisted response body. The live entry keeps the full body
// in memory for the session; we only trim what crosses the rehydrate boundary.
const PERSIST_BODY_LIMIT = 64 * 1024;
// Frames buffer — chattier than HTTP entries, so a larger window in memory.
// Frames are *not* persisted: a busy WebSocket can push 100+ msg/sec, and
// flushing each through IndexedDB encrypt-and-write thrashes the main thread
// for marginal value (frames matter while debugging a live connection;
// surviving reload is rarely useful and not worth the write storm).
const MAX_FRAMES = 500;

export type ConsoleTabId = 'network' | 'scripts' | 'frames' | 'disk';

interface ConsoleState {
  entries: ConsoleEntry[];
  frames: ConsoleFrame[];
  selectedEntryId: string | null;
  isExpanded: boolean;
  panelHeight: number;
  activeTab: ConsoleTabId;
  searchFilter: string;
  statusFilter: ConsoleStatusFilter;
  protocolFilter: ConsoleProtocol | 'all';
  preserveOnSend: boolean;

  // Actions
  addEntry: (entry: Omit<ConsoleEntry, 'id'>) => void;
  clearEntries: () => void;
  removeEntry: (id: string) => void;
  addFrame: (frame: Omit<ConsoleFrame, 'id'>) => void;
  clearFrames: () => void;
  selectEntry: (id: string | null) => void;
  setExpanded: (expanded: boolean) => void;
  setPanelHeight: (height: number) => void;
  setActiveTab: (tab: ConsoleTabId) => void;
  setSearchFilter: (filter: string) => void;
  setStatusFilter: (filter: ConsoleStatusFilter) => void;
  setProtocolFilter: (filter: ConsoleProtocol | 'all') => void;
  setPreserveOnSend: (preserve: boolean) => void;
}

function truncate(str: string, limit: number): string {
  if (str.length <= limit) return str;
  return `${str.slice(0, limit)}…[truncated ${str.length - limit} chars]`;
}

function trimForPersist(entry: ConsoleEntry): ConsoleEntry {
  return {
    ...entry,
    request: {
      ...entry.request,
      ...(entry.request.body !== undefined && {
        body: truncate(entry.request.body, PERSIST_BODY_LIMIT),
      }),
    },
    response: {
      ...entry.response,
      body: truncate(entry.response.body, PERSIST_BODY_LIMIT),
    },
    ...(entry.scriptLogs && {
      scriptLogs: entry.scriptLogs.map((log) => ({
        ...log,
        message: truncate(log.message, PERSIST_LOG_MESSAGE_LIMIT),
      })),
    }),
  };
}

export const useConsoleStore = create<ConsoleState>()(
  persist(
    (set) => ({
      entries: [],
      frames: [],
      selectedEntryId: null,
      isExpanded: false,
      panelHeight: 250,
      activeTab: 'network',
      searchFilter: '',
      statusFilter: 'all',
      protocolFilter: 'all',
      preserveOnSend: true,

      addEntry: (entry) =>
        set((state) => {
          const newEntry: ConsoleEntry = { ...entry, id: uuidv4() };
          const base = state.preserveOnSend ? state.entries : [];
          const newEntries = [newEntry, ...base].slice(0, MAX_ENTRIES);
          return {
            entries: newEntries,
            selectedEntryId: newEntry.id,
          };
        }),

      clearEntries: () =>
        set({
          entries: [],
          selectedEntryId: null,
        }),

      removeEntry: (id) =>
        set((state) => ({
          entries: state.entries.filter((e) => e.id !== id),
          selectedEntryId: state.selectedEntryId === id ? null : state.selectedEntryId,
        })),

      addFrame: (frame) =>
        set((state) => {
          const newFrame: ConsoleFrame = { ...frame, id: uuidv4() };
          // Frames append newest at the *end* — they're chronological logs,
          // not a stack of distinct requests. Tail trim when over cap.
          const next =
            state.frames.length >= MAX_FRAMES
              ? state.frames.slice(state.frames.length - (MAX_FRAMES - 1))
              : state.frames.slice();
          next.push(newFrame);
          return { frames: next };
        }),

      clearFrames: () => set({ frames: [] }),

      selectEntry: (id) => set({ selectedEntryId: id }),

      setExpanded: (expanded) => set({ isExpanded: expanded }),

      setPanelHeight: (height) => set({ panelHeight: height }),

      setActiveTab: (tab: ConsoleTabId) => set({ activeTab: tab }),

      setSearchFilter: (filter) => set({ searchFilter: filter }),

      setStatusFilter: (filter) => set({ statusFilter: filter }),

      setProtocolFilter: (filter) => set({ protocolFilter: filter }),

      setPreserveOnSend: (preserve) => {
        // When toggling OFF, the next send clears prior entries (handled in
        // addEntry). Existing entries stay so the user doesn't lose context
        // mid-debug at the moment they flip the switch.
        set({ preserveOnSend: preserve });
      },
    }),
    {
      name: 'console-storage',
      version: 1,
      storage: dexieStorageAdapters.console(),
      partialize: (state) => ({
        isExpanded: state.isExpanded,
        panelHeight: state.panelHeight,
        activeTab: state.activeTab,
        statusFilter: state.statusFilter,
        protocolFilter: state.protocolFilter,
        preserveOnSend: state.preserveOnSend,
        entries: state.entries.slice(0, PERSIST_ENTRY_LIMIT).map(trimForPersist),
      }),
      onRehydrateStorage: () => (state) => {
        if (!state || !Array.isArray(state.entries)) return;
        // Drop entries that fail schema validation rather than throwing —
        // a single corrupt record shouldn't poison the whole console.
        const valid: ConsoleEntry[] = [];
        for (const candidate of state.entries) {
          const parsed = ConsoleEntrySchema.safeParse(candidate);
          if (parsed.success) valid.push(parsed.data as ConsoleEntry);
        }
        state.entries = valid;
        if (state.selectedEntryId && !valid.some((e) => e.id === state.selectedEntryId)) {
          state.selectedEntryId = null;
        }
      },
    }
  )
);

// Helper to create console entry from request/response
export function createConsoleEntry(
  request: HttpRequest,
  response: ApiResponse,
  sentHeaders: Record<string, string>,
  scriptLogs?: ConsoleLog[],
  tests?: ConsoleTest[],
  protocol: ConsoleProtocol = 'http'
): Omit<ConsoleEntry, 'id'> {
  const body = request.body.type !== 'none' ? request.body.raw : undefined;
  return {
    timestamp: Date.now(),
    protocol,
    request: {
      method: request.method,
      url: request.url,
      headers: sentHeaders,
      ...(body !== undefined && { body }),
    },
    response,
    ...(scriptLogs !== undefined && { scriptLogs }),
    ...(tests !== undefined && { tests }),
  };
}

/**
 * Round-trip a captured entry back into an HttpRequest so it can be replayed
 * in the active tab or opened in a new one. Body type is best-effort — the
 * entry only records the wire form, not the original `RequestBody.type`.
 */
export function entryToHttpRequest(entry: ConsoleEntry): HttpRequest {
  return shapeToHttpRequest(
    entry.request.method,
    entry.request.url,
    entry.request.headers,
    entry.request.body
  );
}

/**
 * Same conversion, lighter input — used by the disk log tab, which only knows
 * method + URL (Electron's file-backed log records no headers or bodies).
 */
export function diskEntryToHttpRequest(method: string, url: string): HttpRequest {
  return shapeToHttpRequest(method, url, {}, undefined);
}

function shapeToHttpRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  rawBody: string | undefined
): HttpRequest {
  const headerList = Object.entries(headers).map(([key, value]) => ({
    id: uuidv4(),
    key,
    value,
    enabled: true,
  }));
  let body: RequestBody = { type: 'none' };
  if (rawBody) {
    const trimmed = rawBody.trim();
    const looksJson = trimmed.startsWith('{') || trimmed.startsWith('[');
    body = { type: looksJson ? 'json' : 'text', raw: rawBody };
  }
  return {
    id: uuidv4(),
    name: `${method} ${url}`,
    type: 'http',
    method: (method as HttpMethod) ?? 'GET',
    url,
    headers: headerList,
    params: [],
    body,
    auth: { type: 'none' },
  };
}

/**
 * Build a `curl` command equivalent to a captured console entry. Used by the
 * entry "Copy as cURL" action; intentionally tighter than the full
 * `codeGenerators/curl.ts` (which needs resolved env vars and settings — a
 * ConsoleEntry already holds the resolved request as it went on the wire).
 */
export function entryToCurl(entry: ConsoleEntry): string {
  const escape = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const parts = [`curl -X ${entry.request.method} ${escape(entry.request.url)}`];
  for (const [key, value] of Object.entries(entry.request.headers)) {
    parts.push(`-H ${escape(`${key}: ${value}`)}`);
  }
  if (entry.request.body) {
    parts.push(`-d ${escape(entry.request.body)}`);
  }
  return parts.join(' \\\n  ');
}
