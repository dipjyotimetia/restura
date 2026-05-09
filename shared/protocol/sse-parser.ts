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
