/**
 * Canonical W3C-compliant SSE event-frame parser shared across worker, Electron
 * main, and the renderer. Implements
 * https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream
 *
 * Stateful: instantiate once per stream, call feed() with each chunk as it
 * arrives, and call flush() at end-of-stream to drain any trailing partial
 * event.
 *
 * Implementation notes:
 * - Uses a streaming TextDecoder so multi-byte UTF-8 sequences split across
 *   chunks decode correctly.
 * - Uses an offset cursor (no repeated buffer.slice on hot path) so feed-heavy
 *   streams don't quadratic-allocate.
 * - Strips a leading BOM only on the very first chunk of the stream.
 * - Normalises CR and CRLF to LF before line-splitting. A CRLF pair split
 *   across two chunks (`\r` ends one, `\n` starts the next) is still a single
 *   line terminator: the `\r` is converted immediately and the orphan `\n` at
 *   the head of the next chunk is dropped.
 * - Tracks the last event ID and reconnection time as *stream* state
 *   (`lastEventId` / `reconnectionTime`), updated by every block that carries
 *   an `id:` / valid `retry:` field — including data-less heartbeat blocks
 *   that are never dispatched. An empty `id:` resets the last event ID to "".
 * - Suppresses field-only blocks that contain no `data:` line, matching the
 *   pre-existing renderer/Electron parser semantics. (The HTML spec would
 *   dispatch such a block with empty data; consumers in this codebase have
 *   never relied on that and it keeps `feed()` callers free of empty-payload
 *   noise.)
 */

export interface SseEvent {
  id?: string;
  event?: string;
  data: string;
  retry?: number;
}

/**
 * Normalised event shape emitted by the renderer/Electron compatibility shims:
 * `event` defaults to "message" and `lastEventId` is carried across events per
 * the W3C spec. Defined here as the single source of truth so the two shims
 * (src/features/sse, electron/main/handlers) don't redeclare it.
 */
export interface ParsedSseEvent {
  event: string;
  data: string;
  lastEventId?: string;
  retry?: number;
}

/**
 * Hard cap on a single un-delimited event frame, measured in JS string length
 * (UTF-16 code units, ~2 bytes each — so this bounds buffer memory at ~16 MiB).
 * An upstream that streams bytes without the `\n\n` block delimiter would
 * otherwise grow `buffer` without bound (the compaction below only advances on
 * a delimiter) — on the Electron main process this is an OOM vector. 8M code
 * units is far beyond any legitimate single SSE event; past it we fail closed
 * so the caller aborts the stream.
 */
/** An event plus the stream's last event ID at the moment it was dispatched. */
export interface DispatchedSseEvent {
  event: SseEvent;
  lastEventId: string | undefined;
}

export const MAX_SSE_EVENT_CHARS = 8 * 1024 * 1024;

export class SseParser {
  private decoder = new TextDecoder();
  private buffer = '';
  private cursor = 0;
  private bomChecked = false;
  /** The previous chunk ended in `\r`; a leading `\n` here completes that CRLF. */
  private pendingCR = false;
  /**
   * WHATWG "last event ID string": set from every completed block with an
   * `id:` field (dispatched or not). `undefined` until the stream sends one;
   * `""` after an empty `id:` — callers must then send no `Last-Event-ID`.
   */
  lastEventId: string | undefined;
  /** Most recent valid `retry:` value (ms), from any completed block. */
  reconnectionTime: number | undefined;

  feed(chunk: Uint8Array): SseEvent[] {
    return this.feedWithState(chunk).map((d) => d.event);
  }

  /**
   * Like `feed()`, but pairs each event with the stream's last event ID as of
   * its dispatch — which an earlier data-less `id:` block in the same chunk
   * may have moved, so it can't be derived from the events alone.
   */
  feedWithState(chunk: Uint8Array): DispatchedSseEvent[] {
    let text = this.decoder.decode(chunk, { stream: true });
    if (text.length > 0) {
      if (this.pendingCR && text.startsWith('\n')) text = text.slice(1);
      this.pendingCR = text.endsWith('\r');
    }
    text = text.replace(/\r\n?/g, '\n');
    if (!this.bomChecked) {
      this.bomChecked = true;
      if (this.buffer === '' && text.startsWith('﻿')) {
        text = text.slice(1);
      }
    }
    this.buffer += text;

    const events: DispatchedSseEvent[] = [];
    for (
      let idx = this.buffer.indexOf('\n\n', this.cursor);
      idx >= 0;
      idx = this.buffer.indexOf('\n\n', this.cursor)
    ) {
      const block = this.buffer.slice(this.cursor, idx);
      this.cursor = idx + 2;
      const event = this.processBlock(block);
      if (event) events.push({ event, lastEventId: this.lastEventId });
    }

    // Compact the buffer when consumed bytes exceed retained bytes, so a
    // many-event stream doesn't grow the string unboundedly.
    if (this.cursor > this.buffer.length / 2) {
      this.buffer = this.buffer.slice(this.cursor);
      this.cursor = 0;
    }

    // After consuming every complete frame, the un-delimited remainder must
    // stay bounded — otherwise an upstream that never sends `\n\n` grows the
    // buffer without limit (main-process OOM). Fail closed so the caller aborts.
    if (this.buffer.length - this.cursor > MAX_SSE_EVENT_CHARS) {
      throw new Error(`SSE event exceeds ${MAX_SSE_EVENT_CHARS} chars without a frame delimiter`);
    }

    return events;
  }

  flush(): SseEvent[] {
    const remaining = this.buffer.slice(this.cursor);
    this.buffer = '';
    this.cursor = 0;
    this.pendingCR = false;
    if (remaining.length === 0) return [];
    const event = this.processBlock(remaining);
    return event ? [event] : [];
  }

  private processBlock(block: string): SseEvent | null {
    const { event, id, retry } = parseEventBlock(block);
    if (id !== undefined) this.lastEventId = id;
    if (retry !== undefined) this.reconnectionTime = retry;
    return event;
  }
}

interface ParsedBlock {
  /** `null` when the block has no `data:` line (not dispatched). */
  event: SseEvent | null;
  id: string | undefined;
  retry: number | undefined;
}

function parseEventBlock(block: string): ParsedBlock {
  const dataLines: string[] = [];
  let id: string | undefined;
  let event: string | undefined;
  let retry: number | undefined;

  for (const line of block.split('\n')) {
    if (line === '') continue;
    if (line.startsWith(':')) continue; // comment
    const colonIdx = line.indexOf(':');
    let field: string;
    let value: string;
    if (colonIdx === -1) {
      // Spec: line with no colon — whole line is the field, value is empty.
      field = line;
      value = '';
    } else {
      field = line.slice(0, colonIdx);
      value = line.slice(colonIdx + 1);
      if (value.startsWith(' ')) value = value.slice(1); // strip ONE leading space
    }
    switch (field) {
      case 'data':
        dataLines.push(value);
        break;
      case 'event':
        if (value !== '') event = value;
        break;
      case 'id':
        // Spec: an empty value is valid and resets the last event ID.
        if (!value.includes('\0')) id = value;
        break;
      case 'retry':
        // Spec: ASCII digits only — anything else (empty, `1e3`, `0x10`,
        // `-1`, `1.5`) is ignored.
        if (/^[0-9]+$/.test(value)) retry = Number.parseInt(value, 10);
        break;
      // Unknown field → ignore (spec)
    }
  }

  if (dataLines.length === 0) return { event: null, id, retry }; // No payload; suppress
  const out: SseEvent = { data: dataLines.join('\n') };
  if (id !== undefined) out.id = id;
  if (event !== undefined) out.event = event;
  if (retry !== undefined) out.retry = retry;
  return { event: out, id, retry };
}

/**
 * WHATWG §9.2.3: a stream may only be reestablished after a 2xx (not 204)
 * reply whose Content-Type is `text/event-stream`; anything else "fails the
 * connection" and must not be retried automatically.
 */
export function isReconnectableSseResponse(status: number, contentType: string | null): boolean {
  if (status < 200 || status >= 300 || status === 204) return false;
  const mime = (contentType ?? '').split(';')[0]?.trim().toLowerCase();
  return mime === 'text/event-stream';
}
