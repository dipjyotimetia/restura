/**
 * Streaming `multipart/mixed` parser (RFC 2046 §5.1). Sister to the SSE and
 * NDJSON parsers in this directory — same feed/flush shape, same home in
 * `shared/protocol/` so every backend and the renderer parse identically.
 *
 * Built for GraphQL incremental delivery (`@defer` / `@stream`), where servers
 * such as graphql-yoga (`boundary="-"`) and Apollo (`boundary="graphql"`)
 * flush one JSON payload per part as results resolve. It is format-agnostic:
 * each emitted part carries its own headers and the raw (decoded) body text.
 *
 * Stateful: instantiate once per response, call feed() with each chunk as it
 * arrives, and flush() at end-of-stream. Parts are emitted as soon as the next
 * delimiter is seen, so a slow server's first part renders before the rest.
 *
 * Implementation notes:
 * - Streaming TextDecoder so multi-byte UTF-8 split across chunks decodes.
 * - A delimiter only counts at the start of a line (or the very start of the
 *   body), per the RFC; a boundary string inside a JSON value cannot match
 *   because JSON escapes newlines.
 * - Empty parts (yoga emits one between its last `---` and the closing
 *   `-----`) are dropped.
 * - The buffer is capped at `maxPartChars` so a malicious or broken upstream
 *   that never sends a delimiter cannot grow memory without bound.
 */

export interface MultipartPart {
  /** Part headers, keys lower-cased. */
  headers: Record<string, string>;
  /** Part body with the delimiter's leading CRLF stripped. */
  body: string;
}

/** Default cap on one part (and on buffered preamble), in UTF-16 chars. */
export const MAX_MULTIPART_PART_CHARS = 16 * 1024 * 1024;

/** True when a Content-Type header names a `multipart/mixed` body. */
export function isMultipartMixed(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  return contentType.split(';')[0]?.trim().toLowerCase() === 'multipart/mixed';
}

/**
 * Extract the `boundary` parameter from a multipart Content-Type. Handles the
 * quoted (`boundary="-"`) and bare (`boundary=graphql`) forms. Returns null
 * when the header is not multipart or has no usable boundary.
 */
export function parseMultipartBoundary(contentType: string | null | undefined): string | null {
  if (!contentType || !contentType.toLowerCase().startsWith('multipart/')) return null;
  for (const raw of contentType.split(';').slice(1)) {
    const eq = raw.indexOf('=');
    if (eq < 0) continue;
    if (raw.slice(0, eq).trim().toLowerCase() !== 'boundary') continue;
    let value = raw.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    // RFC 2046: 1-70 chars. Reject anything that could not be a delimiter.
    if (value.length === 0 || value.length > 70 || /[\r\n]/.test(value)) return null;
    return value;
  }
  return null;
}

export class MultipartMixedParser {
  private readonly delimiter: string;
  private readonly maxPartChars: number;
  private decoder = new TextDecoder();
  private buffer = '';
  /** Where the next delimiter search starts. */
  private scanFrom = 0;
  /** Start offset of the current part's content, or -1 while in the preamble. */
  private partStart = -1;
  /**
   * Offset of a delimiter whose line is still incomplete but whose preceding
   * part was already emitted (-1 when none). Servers flush `\r\n--b` right
   * after a payload and send the line end only with the next part, so waiting
   * for the full line would hold every part back by one.
   */
  private earlyAt = -1;
  private closed = false;

  constructor(boundary: string, options: { maxPartChars?: number } = {}) {
    this.delimiter = `--${boundary}`;
    this.maxPartChars = options.maxPartChars ?? MAX_MULTIPART_PART_CHARS;
  }

  /** True once the closing delimiter (`--boundary--`) has been seen. */
  get done(): boolean {
    return this.closed;
  }

  feed(chunk: Uint8Array | string): MultipartPart[] {
    if (this.closed) return [];
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  /**
   * End of stream. A trailing part without a closing delimiter is still
   * emitted (lenient — some servers drop the epilogue when they close early).
   */
  flush(): MultipartPart[] {
    if (this.closed) return [];
    this.buffer += this.decoder.decode();
    const out = this.drain(true);
    if (!this.closed && this.partStart >= 0 && this.earlyAt < 0) {
      const part = toPart(this.buffer.slice(this.partStart));
      if (part) out.push(part);
    }
    this.closed = true;
    this.buffer = '';
    return out;
  }

  private drain(atEnd: boolean): MultipartPart[] {
    const out: MultipartPart[] = [];
    while (!this.closed) {
      const idx = this.findDelimiter();
      if (idx < 0) {
        // Keep enough tail to recognise a delimiter split across chunks.
        this.scanFrom = Math.max(this.scanFrom, this.buffer.length - this.delimiter.length - 1);
        break;
      }
      const after = idx + this.delimiter.length;
      const lineEnd = this.buffer.indexOf('\n', after);
      const rest = this.buffer.slice(after, lineEnd < 0 ? undefined : lineEnd);
      if (lineEnd < 0 && !atEnd) {
        // The line is incomplete, so `--b`, `--b--` and `--bX` can't be told
        // apart yet. The boundary may not occur at a line start inside a part
        // (RFC 2046), so if what we have can still become a valid delimiter
        // line, release the part before it now.
        if (this.partStart >= 0 && this.earlyAt !== idx && /^(?:-|--)?[ \t]*\r?$/.test(rest)) {
          const part = toPart(this.buffer.slice(this.partStart, idx));
          if (part) out.push(part);
          this.earlyAt = idx;
        }
        break;
      }
      // RFC 2046: the boundary may be followed only by transport padding
      // (spaces / tabs), or by `--` for the close delimiter.
      const isClose = /^--[ \t]*\r?$/.test(rest);
      if (!isClose && !/^[ \t]*\r?$/.test(rest)) {
        // Not a delimiter after all. If its part went out early, the text
        // from here on belongs to a continuation of that part.
        if (this.earlyAt === idx) this.partStart = idx;
        this.earlyAt = -1;
        this.scanFrom = idx + 1;
        continue;
      }
      if (this.partStart >= 0 && this.earlyAt !== idx) {
        const part = toPart(this.buffer.slice(this.partStart, idx));
        if (part) out.push(part);
      }
      if (isClose) {
        this.closed = true;
        this.buffer = '';
        break;
      }
      if (lineEnd < 0) {
        // Bare delimiter at end-of-stream: treat as the close.
        this.closed = true;
        this.buffer = '';
        break;
      }
      this.earlyAt = -1;
      // Compact: drop everything before the new part's content.
      this.buffer = this.buffer.slice(lineEnd + 1);
      this.partStart = 0;
      this.scanFrom = 0;
    }
    const pending = this.partStart >= 0 ? this.buffer.length - this.partStart : this.buffer.length;
    if (!this.closed && pending > this.maxPartChars) {
      throw new Error(`multipart part exceeds ${this.maxPartChars} characters`);
    }
    return out;
  }

  /** Index of the next delimiter that sits at a line start, or -1. */
  private findDelimiter(): number {
    let from = this.scanFrom;
    while (true) {
      const idx = this.buffer.indexOf(this.delimiter, from);
      if (idx < 0) return -1;
      // A delimiter must start a line. Offset 0 is always a line start: either
      // the body's first byte or (after compaction) just past a delimiter line.
      if (idx === 0 || this.buffer[idx - 1] === '\n') return idx;
      from = idx + 1;
    }
  }
}

/**
 * Split raw part text into headers + body. The CRLF that belongs to the next
 * delimiter is stripped. Returns null for an empty part.
 */
function toPart(raw: string): MultipartPart | null {
  let text = raw;
  if (text.endsWith('\r\n')) text = text.slice(0, -2);
  else if (text.endsWith('\n')) text = text.slice(0, -1);
  if (text.trim() === '') return null;

  const headers: Record<string, string> = {};
  const blank = /\r?\n\r?\n/.exec(text);
  const startsBlank = /^\r?\n/.exec(text);
  let body: string;
  if (startsBlank) {
    // No headers: the part opens with the empty line.
    body = text.slice(startsBlank[0].length);
  } else if (blank && looksLikeHeaders(text.slice(0, blank.index))) {
    for (const line of text.slice(0, blank.index).split(/\r?\n/)) {
      // looksLikeHeaders() guarantees every line has a `name:` prefix.
      const colon = line.indexOf(':');
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    body = text.slice(blank.index + blank[0].length);
  } else {
    // Lenient: a server that omits part headers and the blank line.
    body = text;
  }
  if (body.trim() === '') return null;
  return { headers, body };
}

function looksLikeHeaders(block: string): boolean {
  return block.split(/\r?\n/).every((line) => /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\s*:/.test(line));
}

/** Parse a complete (buffered) multipart body into its parts. */
export function parseMultipartMixed(body: string, boundary: string): MultipartPart[] {
  const parser = new MultipartMixedParser(boundary, { maxPartChars: Number.POSITIVE_INFINITY });
  return [...parser.feed(body), ...parser.flush()];
}
