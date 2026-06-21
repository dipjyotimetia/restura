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
 * - Normalises CR and CRLF to LF before line-splitting.
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
export const MAX_SSE_EVENT_CHARS = 8 * 1024 * 1024;

export class SseParser {
  private decoder = new TextDecoder();
  private buffer = '';
  private cursor = 0;
  private bomChecked = false;

  feed(chunk: Uint8Array): SseEvent[] {
    let text = this.decoder.decode(chunk, { stream: true });
    text = text.replace(/\r\n?/g, '\n');
    if (!this.bomChecked) {
      this.bomChecked = true;
      if (this.buffer === '' && text.startsWith('﻿')) {
        text = text.slice(1);
      }
    }
    this.buffer += text;

    const events: SseEvent[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n\n', this.cursor)) >= 0) {
      const block = this.buffer.slice(this.cursor, idx);
      this.cursor = idx + 2;
      const event = parseEventBlock(block);
      if (event) events.push(event);
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
    if (remaining.length === 0) return [];
    const event = parseEventBlock(remaining);
    return event ? [event] : [];
  }
}

function parseEventBlock(block: string): SseEvent | null {
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
        if (value !== '' && !value.includes('\0')) id = value;
        break;
      case 'retry': {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) retry = n;
        break;
      }
      // Unknown field → ignore (spec)
    }
  }

  if (dataLines.length === 0) return null; // No payload; suppress
  const out: SseEvent = { data: dataLines.join('\n') };
  if (id !== undefined) out.id = id;
  if (event !== undefined) out.event = event;
  if (retry !== undefined) out.retry = retry;
  return out;
}
