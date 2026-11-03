/**
 * Streaming newline-delimited JSON parser. Sister to the SSE parser in this
 * directory — same feed/flush shape, same offset-cursor design, same canonical
 * home in `shared/protocol/`.
 *
 * Stateful: instantiate once per stream, call feed() with each chunk as it
 * arrives, and call flush() at end-of-stream to drain any trailing partial
 * line.
 *
 * Each emitted value is either:
 * - the JSON-parsed value (any type), OR
 * - an NdjsonParseError sentinel (`{ __parseError: line }`) when the line was
 *   non-empty but JSON.parse threw. This lets consumers surface the bad line
 *   to the user instead of aborting the whole stream.
 *
 * Implementation notes:
 * - Streaming TextDecoder so multi-byte UTF-8 sequences split across chunks
 *   decode correctly.
 * - Offset cursor (no repeated buffer.slice on hot path) so feed-heavy streams
 *   don't quadratic-allocate; periodic compaction keeps the string bounded.
 * - Strips a leading BOM only on the very first chunk of the stream.
 * - Normalises CR and CRLF to LF before line-splitting.
 */

export interface NdjsonParseError {
  __parseError: string;
}

export type NdjsonValue = unknown;

/**
 * Hard cap on a single unterminated line, in UTF-16 code units (~16 MiB) —
 * the same bound and fail-closed behaviour as `MAX_SSE_EVENT_CHARS`.
 */
export const MAX_NDJSON_LINE_CHARS = 8 * 1024 * 1024;

export class NdjsonParser {
  private decoder = new TextDecoder();
  private buffer = '';
  private cursor = 0;
  private bomChecked = false;

  feed(chunk: Uint8Array): NdjsonValue[] {
    let text = this.decoder.decode(chunk, { stream: true });
    text = text.replace(/\r\n?/g, '\n');
    if (!this.bomChecked) {
      this.bomChecked = true;
      if (this.buffer === '' && text.startsWith('﻿')) {
        text = text.slice(1);
      }
    }
    // Only the new text can hold a new delimiter — the unterminated tail was
    // already scanned, so a long line costs O(bytes), not O(n²). The buffer is
    // not even searched unless the new text has one: searching it makes V8
    // flatten the whole `+=` rope (a full copy).
    const scanFrom = Math.max(this.cursor, this.buffer.length);
    const mayComplete = text.includes('\n');
    this.buffer += text;

    const out: NdjsonValue[] = [];
    for (
      let idx = mayComplete ? this.buffer.indexOf('\n', scanFrom) : -1;
      idx >= 0;
      idx = this.buffer.indexOf('\n', this.cursor)
    ) {
      const line = this.buffer.slice(this.cursor, idx);
      this.cursor = idx + 1;
      const parsed = parseLine(line);
      if (parsed !== SKIP) out.push(parsed);
    }

    // Compact the buffer when consumed bytes exceed retained bytes, so a
    // many-line stream doesn't grow the string unboundedly.
    if (this.cursor > this.buffer.length / 2) {
      this.buffer = this.buffer.slice(this.cursor);
      this.cursor = 0;
    }

    // An upstream that never sends `\n` would otherwise grow the buffer
    // without limit (main-process OOM). Fail closed so the caller aborts.
    if (this.buffer.length - this.cursor > MAX_NDJSON_LINE_CHARS) {
      throw new Error(`NDJSON line exceeds ${MAX_NDJSON_LINE_CHARS} chars without a newline`);
    }

    return out;
  }

  flush(): NdjsonValue[] {
    const remaining = this.buffer.slice(this.cursor);
    this.buffer = '';
    this.cursor = 0;
    if (remaining.length === 0) return [];
    const parsed = parseLine(remaining);
    return parsed === SKIP ? [] : [parsed];
  }
}

const SKIP = Symbol('skip');
type SkipMarker = typeof SKIP;

function parseLine(line: string): NdjsonValue | SkipMarker {
  if (line === '') return SKIP;
  try {
    return JSON.parse(line);
  } catch {
    return { __parseError: line } satisfies NdjsonParseError;
  }
}
