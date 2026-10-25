import { create } from 'zustand';
import {
  appendToTimeline,
  EVENT_PAYLOAD_LIMIT,
  normalizeStreamEvent,
  type StreamEvent,
  type StreamEventInput,
} from '@/lib/shared/stream-timeline';

/**
 * Unified streaming timeline store (issue #971).
 *
 * Protocol stores call `emitStreamEvent(...)` — a cheap push onto a module
 * queue. A single timer flushes the queue every TIMELINE_FLUSH_MS into one
 * Zustand update, so a 1k msg/s stream costs ~10 renders/s instead of 1000.
 * The buffer is a count- and byte-capped ring: oldest events are evicted
 * first. Memory-only by design — never persisted.
 */

export const TIMELINE_FLUSH_MS = 100;
export const TIMELINE_MAX_EVENTS = 5000;
export const TIMELINE_MAX_BYTES = 8 * 1024 * 1024;

interface StreamTimelineState {
  events: StreamEvent[];
  totalBytes: number;
  evicted: number;
  paused: boolean;
  /** Apply any queued events now (the timer calls this; exposed for tests/export). */
  flush: () => void;
  clear: () => void;
  setPaused: (paused: boolean) => void;
}

let pending: StreamEventInput[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let seq = 0;

/** Upper-bound the retained footprint of a raw input (payload is capped at EVENT_PAYLOAD_LIMIT). */
function inputBytes(input: StreamEventInput): number {
  return 96 + Math.min(input.payload.length, EVENT_PAYLOAD_LIMIT) * 2;
}

function tailWithinByteCap(batch: StreamEventInput[], maxBytes: number): StreamEventInput[] {
  let total = 0;
  let start = batch.length;
  while (start > 0) {
    total += inputBytes(batch[start - 1]!);
    if (total > maxBytes) break;
    start -= 1;
  }
  return start === 0 ? batch : batch.slice(start);
}

function cancelTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

export const useStreamTimelineStore = create<StreamTimelineState>()((set, get) => ({
  events: [],
  totalBytes: 0,
  evicted: 0,
  paused: false,

  flush: () => {
    cancelTimer();
    if (pending.length === 0) return;
    const queued = pending;
    pending = [];
    // The byte cap means only a tail of a large batch can survive eviction, so
    // don't pay for redaction on events that would be dropped immediately
    // (5000 x 64KB frames otherwise stall the main thread for ~1s per flush).
    const survivors = tailWithinByteCap(queued, TIMELINE_MAX_BYTES);
    const skipped = queued.length - survivors.length;
    seq += skipped;
    // Normalisation (redaction + truncation) runs here, off the emit hot path.
    const normalized = survivors.map((input) => normalizeStreamEvent(input, ++seq));
    const s = get();
    const next = appendToTimeline(
      { events: s.events, totalBytes: s.totalBytes, evicted: s.evicted },
      normalized,
      { maxEvents: TIMELINE_MAX_EVENTS, maxBytes: TIMELINE_MAX_BYTES }
    );
    set(skipped > 0 ? { ...next, evicted: next.evicted + skipped } : next);
  },

  clear: () => {
    cancelTimer();
    pending = [];
    set({ events: [], totalBytes: 0, evicted: 0 });
  },

  setPaused: (paused) => set({ paused }),
}));

/** The single call each streaming protocol store makes per logged message. */
export function emitStreamEvent(input: StreamEventInput): void {
  if (useStreamTimelineStore.getState().paused) return;
  pending.push(input.ts === undefined ? { ...input, ts: Date.now() } : input);
  // Bound the queue between flushes so a stalled timer can't grow it forever.
  if (pending.length > TIMELINE_MAX_EVENTS) pending = pending.slice(-TIMELINE_MAX_EVENTS);
  if (timer === null) {
    timer = setTimeout(() => useStreamTimelineStore.getState().flush(), TIMELINE_FLUSH_MS);
  }
}
