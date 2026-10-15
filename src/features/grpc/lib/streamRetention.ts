/**
 * Renderer-side memory bound for gRPC stream messages.
 *
 * The desktop main process caps each message (MAX_RESPONSE_SIZE, #929) but no
 * longer caps a stream's total, so a long-lived watch/subscribe stream would
 * otherwise grow the renderer's message list without limit. Only the most
 * recent messages are kept — at most MAX_RETAINED_STREAM_MESSAGES and
 * MAX_RETAINED_STREAM_BYTES of JSON text — and the number dropped from the
 * front is counted so the UI can say "N earlier messages dropped".
 */

export const MAX_RETAINED_STREAM_MESSAGES = 1000;
/** Same budget the old main-side stream total used (10 MB). */
export const MAX_RETAINED_STREAM_BYTES = 10 * 1024 * 1024;

export interface StreamRetentionLimits {
  maxMessages: number;
  maxBytes: number;
}

const DEFAULT_LIMITS: StreamRetentionLimits = {
  maxMessages: MAX_RETAINED_STREAM_MESSAGES,
  maxBytes: MAX_RETAINED_STREAM_BYTES,
};

/** Retained window: newest-last items, their total size, and how many were dropped. */
export interface RetainedMessages<T> {
  items: T[];
  bytes: number;
  dropped: number;
}

export function emptyRetained<T>(): RetainedMessages<T> {
  return { items: [], bytes: 0, dropped: 0 };
}

/**
 * Mutable bounded FIFO for a single stream run. Sizes are tracked alongside
 * items so eviction never re-measures. A single message larger than the byte
 * budget is dropped (and counted) rather than retained, so the budget is a hard
 * ceiling even when decoded JSON expands past the wire-level frame cap.
 */
export class StreamMessageBuffer<T> {
  private readonly items: T[] = [];
  private readonly sizes: number[] = [];
  private bytes = 0;
  private dropped = 0;

  constructor(private readonly limits: StreamRetentionLimits = DEFAULT_LIMITS) {}

  push(item: T, size: number): void {
    if (size > this.limits.maxBytes) {
      this.dropped += 1;
      return;
    }
    this.items.push(item);
    this.sizes.push(size);
    this.bytes += size;
    while (
      this.items.length > 1 &&
      (this.items.length > this.limits.maxMessages || this.bytes > this.limits.maxBytes)
    ) {
      this.items.shift();
      this.bytes -= this.sizes.shift() ?? 0;
      this.dropped += 1;
    }
  }

  snapshot(): RetainedMessages<T> {
    return { items: [...this.items], bytes: this.bytes, dropped: this.dropped };
  }
}

/**
 * Immutable append for React state: returns a new window with `text` added and
 * the oldest messages evicted past the limits. Size is the UTF-16 length, a
 * cheap proxy for the retained string's memory.
 */
export function appendRetained(
  prev: RetainedMessages<string>,
  text: string,
  limits: StreamRetentionLimits = DEFAULT_LIMITS
): RetainedMessages<string> {
  const buf = new StreamMessageBuffer<string>(limits);
  // Re-seeding keeps eviction in one place; windows are small (≤ maxMessages).
  for (const item of prev.items) buf.push(item, item.length);
  buf.push(text, text.length);
  const next = buf.snapshot();
  return { ...next, dropped: prev.dropped + next.dropped };
}

/** Wrap an already-bounded list (e.g. a finished response's messages). */
export function retainedFrom(items: string[] | undefined, dropped = 0): RetainedMessages<string> {
  const list = items ?? [];
  return { items: list, bytes: list.reduce((n, s) => n + s.length, 0), dropped };
}
