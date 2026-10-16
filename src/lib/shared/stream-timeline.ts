/**
 * Unified streaming timeline (issue #971) — the pure half.
 *
 * Every streaming protocol store (WebSocket, Socket.IO, SSE, Kafka, MQTT)
 * emits a `StreamEvent` envelope into one cross-protocol timeline. This
 * module owns the envelope shape, the byte/count-capped ring-buffer append,
 * search compilation (text / guarded regex / JSONPath), filtering and JSONL
 * export. The batched Zustand store lives in `@/store/useStreamTimelineStore`.
 *
 * Payloads are exactly what the per-protocol logs already show, passed
 * through the console redaction pass. The timeline is memory-only — it is
 * never persisted.
 */
import { JSONPath } from 'jsonpath-plus';
import { sanitizeConsoleText } from '@/lib/shared/console-sanitization';
import { truncateForPersist } from '@/lib/shared/utils';

export type StreamProtocol = 'websocket' | 'socketio' | 'sse' | 'kafka' | 'mqtt';
export type StreamDirection = 'in' | 'out' | 'system';
export type StreamEventKind = 'message' | 'system' | 'ack' | 'error';
export type StreamMetaValue = string | number | boolean;

export const STREAM_PROTOCOLS: readonly StreamProtocol[] = [
  'websocket',
  'socketio',
  'sse',
  'kafka',
  'mqtt',
];

/** What a protocol store hands to `emitStreamEvent` — one call, no ids. */
export interface StreamEventInput {
  ts?: number;
  protocol: StreamProtocol;
  connectionId: string;
  direction: StreamDirection;
  kind?: StreamEventKind | undefined;
  /** Protocol label: WS data type, Socket.IO event, SSE event, Kafka/MQTT topic. */
  label?: string | undefined;
  /** Text preview — binary payloads arrive pre-stringified, as the per-protocol log shows them. */
  payload: string;
  /** True wire size in bytes when known. */
  size?: number | undefined;
  /** Small scalar protocol facts (partition/offset, qos/retain, lastEventId, ackId…). */
  meta?: Record<string, StreamMetaValue | undefined>;
}

export interface StreamEvent {
  id: string;
  /** Monotonic arrival order — stable tie-breaker for equal timestamps. */
  seq: number;
  ts: number;
  protocol: StreamProtocol;
  connectionId: string;
  direction: StreamDirection;
  kind: StreamEventKind;
  label?: string;
  payload: string;
  size: number;
  meta: Record<string, StreamMetaValue>;
  /** Set when the stored payload preview was cut at EVENT_PAYLOAD_LIMIT. */
  truncated?: boolean;
}

/** Per-event payload cap (UTF-16 units). The byte cap bounds the total. */
export const EVENT_PAYLOAD_LIMIT = 64 * 1024;
/** Fixed per-event overhead estimate (ids, numbers, object headers). */
const EVENT_OVERHEAD_BYTES = 96;

export function normalizeStreamEvent(input: StreamEventInput, seq: number): StreamEvent {
  const meta: Record<string, StreamMetaValue> = {};
  if (input.meta) {
    for (const [k, v] of Object.entries(input.meta)) {
      if (v !== undefined) meta[k] = typeof v === 'string' ? sanitizeConsoleText(v) : v;
    }
  }
  const redacted = sanitizeConsoleText(input.payload);
  const truncated = redacted.length > EVENT_PAYLOAD_LIMIT;
  const event: StreamEvent = {
    id: `${input.protocol}-${seq}`,
    seq,
    ts: input.ts ?? Date.now(),
    protocol: input.protocol,
    connectionId: input.connectionId,
    direction: input.direction,
    kind: input.kind ?? (input.direction === 'system' ? 'system' : 'message'),
    payload: truncated ? truncateForPersist(redacted, EVENT_PAYLOAD_LIMIT) : redacted,
    size: input.size ?? input.payload.length,
    meta,
  };
  if (input.label !== undefined) event.label = sanitizeConsoleText(input.label);
  if (truncated) event.truncated = true;
  return event;
}

/** Approximate in-memory footprint (UTF-16 strings ≈ 2 bytes/unit). */
export function estimateEventBytes(event: StreamEvent): number {
  let bytes = EVENT_OVERHEAD_BYTES + event.payload.length * 2 + event.connectionId.length * 2;
  if (event.label) bytes += event.label.length * 2;
  for (const [k, v] of Object.entries(event.meta)) {
    bytes += k.length * 2 + (typeof v === 'string' ? v.length * 2 : 8);
  }
  return bytes;
}

export interface TimelineBuffer {
  events: StreamEvent[];
  totalBytes: number;
  /** Count of events dropped by the caps since the last clear. */
  evicted: number;
}

export interface TimelineCaps {
  maxEvents: number;
  maxBytes: number;
}

/**
 * Append a batch and evict from the head until both caps hold. Called once
 * per flush (not per event), so the single concat + slice is amortised.
 */
export function appendToTimeline(
  state: TimelineBuffer,
  batch: StreamEvent[],
  caps: TimelineCaps
): TimelineBuffer {
  if (batch.length === 0) return state;
  const merged = state.events.concat(batch);
  let total = state.totalBytes;
  for (const e of batch) total += estimateEventBytes(e);
  let start = 0;
  while (
    start < merged.length &&
    (merged.length - start > caps.maxEvents || total > caps.maxBytes)
  ) {
    total -= estimateEventBytes(merged[start]!);
    start += 1;
  }
  return {
    events: start === 0 ? merged : merged.slice(start),
    totalBytes: total,
    evicted: state.evicted + start,
  };
}

// --- Search ---------------------------------------------------------------

export type TimelineSearchMode = 'text' | 'regex' | 'jsonpath';
export type TimelineMatcher = (event: StreamEvent) => boolean;
export type CompiledSearch = { ok: true; match: TimelineMatcher } | { ok: false; error: string };

const MAX_REGEX_LENGTH = 256;
/** Regex/JSONPath only inspect this much of each payload — bounds per-event cost. */
const SEARCH_SCAN_LIMIT = 16 * 1024;

const matchAll: TimelineMatcher = () => true;

/**
 * Reject patterns prone to catastrophic backtracking before they ever run on
 * the main thread. Conservative heuristics (false positives are fine — the
 * user can rephrase): a quantified group whose body itself contains a
 * quantifier or an alternation, and backreferences.
 */
export function validateTimelineRegex(pattern: string): string | null {
  if (pattern.length > MAX_REGEX_LENGTH) {
    return `Pattern too long (max ${MAX_REGEX_LENGTH} characters)`;
  }
  if (/\\[1-9]|\\k</.test(pattern)) return 'Backreferences are not supported';
  try {
    new RegExp(pattern);
  } catch (err) {
    return `Invalid regex: ${String(err)}`;
  }
  // Walk groups with a stack; when a group closes and is followed by a
  // quantifier, reject if its body contained a quantifier or a `|`.
  const stack: Array<{ quantified: boolean; alternation: boolean }> = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === '(') {
      stack.push({ quantified: false, alternation: false });
      continue;
    }
    const top = stack[stack.length - 1];
    if (ch === '|' && top) {
      top.alternation = true;
      continue;
    }
    if ((ch === '*' || ch === '+' || ch === '{') && top) top.quantified = true;
    if (ch === ')') {
      const group = stack.pop();
      const next = pattern[i + 1];
      const followedByQuantifier = next === '*' || next === '+' || next === '{';
      if (group && followedByQuantifier) {
        if (group.quantified) return 'Nested quantifiers can hang the UI — simplify the pattern';
        if (group.alternation) {
          return 'Quantified alternation can hang the UI — simplify the pattern';
        }
      }
      // A quantified group counts as a quantifier inside its parent.
      const parent = stack[stack.length - 1];
      if (parent && (followedByQuantifier || group?.quantified)) parent.quantified = true;
    }
  }
  return null;
}

const jsonCache = new WeakMap<StreamEvent, { value: unknown } | null>();

function parsedPayload(event: StreamEvent): { value: unknown } | null {
  const cached = jsonCache.get(event);
  if (cached !== undefined) return cached;
  let result: { value: unknown } | null = null;
  const text = event.payload.trimStart();
  if (
    !event.truncated &&
    text.length <= SEARCH_SCAN_LIMIT &&
    (text[0] === '{' || text[0] === '[')
  ) {
    try {
      result = { value: JSON.parse(text) };
    } catch {
      result = null;
    }
  }
  jsonCache.set(event, result);
  return result;
}

export function compileTimelineSearch(mode: TimelineSearchMode, query: string): CompiledSearch {
  const q = query.trim();
  if (!q) return { ok: true, match: matchAll };
  if (mode === 'text') {
    const needle = q.toLowerCase();
    return {
      ok: true,
      match: (e) =>
        e.payload.toLowerCase().includes(needle) ||
        (e.label ?? '').toLowerCase().includes(needle) ||
        e.connectionId.toLowerCase().includes(needle),
    };
  }
  if (mode === 'regex') {
    const problem = validateTimelineRegex(q);
    if (problem) return { ok: false, error: problem };
    const re = new RegExp(q, 'i');
    return {
      ok: true,
      match: (e) => re.test(e.payload.slice(0, SEARCH_SCAN_LIMIT)) || re.test(e.label ?? ''),
    };
  }
  if (!q.startsWith('$')) return { ok: false, error: 'JSONPath must start with $' };
  try {
    // Probe once so syntax errors surface as a message, not per-event throws.
    // Filters only evaluate against children, so the probe needs a nested value.
    JSONPath({ path: q, json: { probe: { value: 1 } }, wrap: true });
  } catch (err) {
    return { ok: false, error: `Invalid JSONPath: ${String(err)}` };
  }
  return {
    ok: true,
    match: (e) => {
      const parsed = parsedPayload(e);
      if (!parsed || parsed.value === null || typeof parsed.value !== 'object') return false;
      try {
        const out = JSONPath({ path: q, json: parsed.value as object, wrap: true });
        return Array.isArray(out) && out.length > 0;
      } catch {
        return false;
      }
    },
  };
}

export interface TimelineFilter {
  /** null = all protocols. */
  protocols: ReadonlySet<StreamProtocol> | null;
  connectionId: string | 'all';
  match: TimelineMatcher;
}

export function filterTimeline(events: StreamEvent[], filter: TimelineFilter): StreamEvent[] {
  return events.filter(
    (e) =>
      (filter.protocols === null || filter.protocols.has(e.protocol)) &&
      (filter.connectionId === 'all' || e.connectionId === filter.connectionId) &&
      filter.match(e)
  );
}

// --- Export ---------------------------------------------------------------

/** One JSON object per line; internal ids/seq are dropped, ISO time added. */
export function buildTimelineJsonl(events: StreamEvent[]): string {
  if (events.length === 0) return '';
  const lines = events.map((e) =>
    JSON.stringify({
      ts: e.ts,
      time: new Date(e.ts).toISOString(),
      protocol: e.protocol,
      connectionId: e.connectionId,
      direction: e.direction,
      kind: e.kind,
      ...(e.label !== undefined && { label: e.label }),
      payload: e.payload,
      size: e.size,
      ...(e.truncated && { truncated: true }),
      meta: e.meta,
    })
  );
  return `${lines.join('\n')}\n`;
}

/** "+1.25s" style delta used for relative timing in the panel. */
export function formatDelta(ms: number): string {
  const sign = ms < 0 ? '-' : '+';
  const abs = Math.abs(ms);
  if (abs < 1000) return `${sign}${Math.round(abs)}ms`;
  if (abs < 60_000) return `${sign}${(abs / 1000).toFixed(2)}s`;
  return `${sign}${(abs / 60_000).toFixed(1)}m`;
}
