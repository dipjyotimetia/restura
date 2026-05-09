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
    this.buffer += text;

    const out: NdjsonValue[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n', this.cursor)) >= 0) {
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
