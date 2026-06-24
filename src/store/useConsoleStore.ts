import { v4 as uuidv4 } from 'uuid';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
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
  | 'mqtt'
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
  /** Bytes sent on the wire (body + headers), when measurable. */
  requestSize?: number;
  /** Pinned entries survive preserve-on-send clears and trimming. */
  pinned?: boolean;
  /** Set when the response body exceeded LIVE_BODY_LIMIT and was cut at capture. */
  bodyTruncated?: boolean;
  /** Collection-run provenance — set when this entry was produced by the runner. */
  runId?: string;
  runLabel?: string;
  iteration?: number;
}

export type FrameProtocol = 'websocket' | 'socketio' | 'kafka' | 'mqtt' | 'sse';
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
// Per-frame payload cap. MAX_FRAMES bounds the count but not the bytes — 500
// frames of large SSE events (an LLM streaming completion is the canonical
// case) could otherwise retain tens of MB for the session. The frame's
// `bytes` field still records the true size, so the UI shows real numbers
// even when the preview is cut.
const FRAME_PAYLOAD_LIMIT = 64 * 1024;
// In-memory cap per captured body. A pathological 100 MB response would
// otherwise sit in RAM for the whole session (×100 entries). 5 MB keeps
// Expand/Compare/replay intact for any realistic payload while bounding the
// worst case; persist trims further (PERSIST_BODY_LIMIT) at the reload
// boundary. Entries cut here carry `bodyTruncated` so the UI can say so.
const LIVE_BODY_LIMIT = 5 * 1024 * 1024;

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
  /** Run id from the collection runner (or 'all'). Lives in the store so the
   *  export menu and any other consumer outside NetworkTab can read the
   *  currently-applied filter set without prop-drilling. */
  runFilter: string;
  preserveOnSend: boolean;
  /** Pause switch — when false, addEntry/addFrame(s) are no-ops so the user
   *  can freeze the console while inspecting bursty traffic. */
  captureEnabled: boolean;

  // Actions
  addEntry: (entry: Omit<ConsoleEntry, 'id'>) => void;
  clearEntries: () => void;
  removeEntry: (id: string) => void;
  togglePin: (id: string) => void;
  addFrame: (frame: Omit<ConsoleFrame, 'id'>) => void;
  /** Batch append — one store update for many frames (high-throughput streams). */
  addFrames: (frames: Array<Omit<ConsoleFrame, 'id'>>) => void;
  clearFrames: () => void;
  selectEntry: (id: string | null) => void;
  setExpanded: (expanded: boolean) => void;
  setPanelHeight: (height: number) => void;
  setActiveTab: (tab: ConsoleTabId) => void;
  setSearchFilter: (filter: string) => void;
  setStatusFilter: (filter: ConsoleStatusFilter) => void;
  setProtocolFilter: (filter: ConsoleProtocol | 'all') => void;
  setRunFilter: (filter: string) => void;
  setPreserveOnSend: (preserve: boolean) => void;
  setCaptureEnabled: (enabled: boolean) => void;
}

function truncate(str: string, limit: number): string {
  if (str.length <= limit) return str;
  return `${str.slice(0, limit)}…[truncated ${str.length - limit} chars]`;
}

/**
 * Cap the entry list to MAX_ENTRIES while never evicting pinned entries.
 * Preserves order (newest first); pinned entries beyond the cap still survive.
 */
function capEntries(entries: ConsoleEntry[]): ConsoleEntry[] {
  if (entries.length <= MAX_ENTRIES) return entries;
  const pinned = entries.filter((e) => e.pinned);
  const unpinned = entries.filter((e) => !e.pinned);
  const room = Math.max(0, MAX_ENTRIES - pinned.length);
  const keptUnpinned = new Set(unpinned.slice(0, room));
  // Re-walk the original order so pinned + kept-unpinned stay interleaved as-is.
  return entries.filter((e) => e.pinned || keptUnpinned.has(e));
}

/**
 * Bound the in-memory footprint of a captured entry. Bodies over
 * LIVE_BODY_LIMIT are cut at capture time (with `bodyTruncated` set) so a
 * single pathological response can't pin tens of MB in RAM for the session.
 * The limit is measured in UTF-16 code units (string length), not bytes —
 * multi-byte text can occupy up to ~2× the nominal cap, which is fine here.
 */
function capLiveBody(entry: Omit<ConsoleEntry, 'id'>): Omit<ConsoleEntry, 'id'> {
  const requestOver = (entry.request.body?.length ?? 0) > LIVE_BODY_LIMIT;
  const responseOver = entry.response.body.length > LIVE_BODY_LIMIT;
  if (!requestOver && !responseOver) return entry;
  return {
    ...entry,
    bodyTruncated: true,
    request: requestOver
      ? { ...entry.request, body: truncate(entry.request.body!, LIVE_BODY_LIMIT) }
      : entry.request,
    response: responseOver
      ? { ...entry.response, body: truncate(entry.response.body, LIVE_BODY_LIMIT) }
      : entry.response,
  };
}

/** Frame analogue of capLiveBody — bounds per-frame payload bytes at capture. */
function capFramePayload(frame: Omit<ConsoleFrame, 'id'>): Omit<ConsoleFrame, 'id'> {
  if (frame.payload.length <= FRAME_PAYLOAD_LIMIT) return frame;
  return { ...frame, payload: truncate(frame.payload, FRAME_PAYLOAD_LIMIT) };
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
      runFilter: 'all',
      preserveOnSend: true,
      captureEnabled: true,

      addEntry: (entry) =>
        set((state) => {
          if (!state.captureEnabled) return state;
          const newEntry: ConsoleEntry = { ...capLiveBody(entry), id: uuidv4() };
          // preserve-off still keeps pinned entries — pins are an explicit "keep this".
          const base = state.preserveOnSend ? state.entries : state.entries.filter((e) => e.pinned);
          const capped = capEntries([newEntry, ...base]);
          // With MAX_ENTRIES pinned entries, capEntries evicts the new entry
          // immediately — selecting it would dangle (detail pane finds nothing).
          const survived = capped.some((e) => e.id === newEntry.id);
          return {
            entries: capped,
            selectedEntryId: survived ? newEntry.id : state.selectedEntryId,
          };
        }),

      clearEntries: () =>
        set((state) => {
          const pinned = state.entries.filter((e) => e.pinned);
          return {
            entries: pinned,
            selectedEntryId: null,
          };
        }),

      removeEntry: (id) =>
        set((state) => ({
          entries: state.entries.filter((e) => e.id !== id),
          selectedEntryId: state.selectedEntryId === id ? null : state.selectedEntryId,
        })),

      togglePin: (id) =>
        set((state) => ({
          entries: state.entries.map((e) => (e.id === id ? { ...e, pinned: !e.pinned } : e)),
        })),

      addFrame: (frame) =>
        set((state) => {
          if (!state.captureEnabled) return state;
          const newFrame: ConsoleFrame = { ...capFramePayload(frame), id: uuidv4() };
          // Frames append newest at the *end* — they're chronological logs,
          // not a stack of distinct requests. Tail trim when over cap.
          const next =
            state.frames.length >= MAX_FRAMES
              ? state.frames.slice(state.frames.length - (MAX_FRAMES - 1))
              : state.frames.slice();
          next.push(newFrame);
          return { frames: next };
        }),

      addFrames: (frames) =>
        set((state) => {
          if (!state.captureEnabled || frames.length === 0) return state;
          const incoming: ConsoleFrame[] = frames.map((f) => ({
            ...capFramePayload(f),
            id: uuidv4(),
          }));
          const merged = state.frames.concat(incoming);
          const next =
            merged.length > MAX_FRAMES ? merged.slice(merged.length - MAX_FRAMES) : merged;
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

      setRunFilter: (filter) => set({ runFilter: filter }),

      setPreserveOnSend: (preserve) => {
        // When toggling OFF, the next send clears prior entries (handled in
        // addEntry). Existing entries stay so the user doesn't lose context
        // mid-debug at the moment they flip the switch.
        set({ preserveOnSend: preserve });
      },

      setCaptureEnabled: (enabled) => set({ captureEnabled: enabled }),
    }),
    {
      name: 'console-storage',
      version: 1,
      storage: dexieStorageAdapters.console(),
      partialize: (state) => ({
        isExpanded: state.isExpanded,
        panelHeight: state.panelHeight,
        activeTab: state.activeTab,
        searchFilter: state.searchFilter,
        statusFilter: state.statusFilter,
        protocolFilter: state.protocolFilter,
        // runFilter intentionally not persisted — run IDs are session-scoped.
        preserveOnSend: state.preserveOnSend,
        captureEnabled: state.captureEnabled,
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

/** Estimate bytes sent on the wire: header lines + body. Cheap, good enough for a size column. */
export function estimateRequestSize(headers: Record<string, string>, body?: string): number {
  let bytes = 0;
  for (const [k, v] of Object.entries(headers)) {
    bytes += k.length + (v?.length ?? 0) + 4; // ": " + CRLF
  }
  if (body) bytes += new TextEncoder().encode(body).length;
  return bytes;
}

/** Optional provenance / metrics attached to a console entry. */
export interface ConsoleEntryExtra {
  requestSize?: number;
  runId?: string;
  runLabel?: string;
  iteration?: number;
}

// Helper to create console entry from request/response
export function createConsoleEntry(
  request: HttpRequest,
  response: ApiResponse,
  sentHeaders: Record<string, string>,
  scriptLogs?: ConsoleLog[],
  tests?: ConsoleTest[],
  protocol: ConsoleProtocol = 'http',
  extra?: ConsoleEntryExtra
): Omit<ConsoleEntry, 'id'> {
  const body = request.body.type !== 'none' ? request.body.raw : undefined;
  const requestSize = extra?.requestSize ?? estimateRequestSize(sentHeaders, body);
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
    requestSize,
    ...(scriptLogs !== undefined && { scriptLogs }),
    ...(tests !== undefined && { tests }),
    ...(extra?.runId !== undefined && { runId: extra.runId }),
    ...(extra?.runLabel !== undefined && { runLabel: extra.runLabel }),
    ...(extra?.iteration !== undefined && { iteration: extra.iteration }),
  };
}

/**
 * Generalized console-entry builder for non-HTTP-shaped protocols (gRPC,
 * GraphQL, MCP, …). `createConsoleEntry` above takes a full `HttpRequest`;
 * interactive sends of other protocols carry their own request shapes, so
 * this variant takes the wire-level facts directly. `method`/`url` are the
 * protocol's closest analogue (e.g. `Service/Method` + target for gRPC).
 */
export function createProtocolConsoleEntry(args: {
  protocol: ConsoleProtocol;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  response: ApiResponse;
  scriptLogs?: ConsoleLog[];
  tests?: ConsoleTest[];
  extra?: ConsoleEntryExtra;
}): Omit<ConsoleEntry, 'id'> {
  const headers = args.headers ?? {};
  const requestSize = args.extra?.requestSize ?? estimateRequestSize(headers, args.body);
  return {
    timestamp: Date.now(),
    protocol: args.protocol,
    request: {
      method: args.method,
      url: args.url,
      headers,
      ...(args.body !== undefined && { body: args.body }),
    },
    response: args.response,
    requestSize,
    ...(args.scriptLogs !== undefined && { scriptLogs: args.scriptLogs }),
    ...(args.tests !== undefined && { tests: args.tests }),
    ...(args.extra?.runId !== undefined && { runId: args.extra.runId }),
    ...(args.extra?.runLabel !== undefined && { runLabel: args.extra.runLabel }),
    ...(args.extra?.iteration !== undefined && { iteration: args.extra.iteration }),
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
