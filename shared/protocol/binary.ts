/**
 * Binary-response handling shared by every backend (Worker + Electron).
 *
 * The proxy historically buffered upstream bodies via `response.text()`, which
 * UTF-8-decodes the bytes and corrupts anything that isn't text (images, PDFs,
 * fonts, archives). To let the renderer reconstruct those bytes (e.g. to preview
 * an image), the proxy now detects binary content types, reads the raw stream,
 * and base64-encodes it — tagging the response with `bodyEncoding: 'base64'`.
 *
 * Kept backend-agnostic (no Node/Worker-specific APIs): `btoa` and the Web
 * Streams API are available in both the Cloudflare runtime and Electron main.
 */

/**
 * Content types we keep as UTF-8 text. Everything else *with a body* is treated
 * as binary and base64-encoded. A missing/blank content type stays text — that
 * preserves the prior behaviour for the many APIs that omit it on JSON.
 *
 * Note `image/svg+xml` is intentionally text (it's markup, renders in an
 * <iframe>/inline), while raster image types fall through to binary.
 */
const TEXT_CONTENT_TYPE_RE =
  /^(?:text\/|application\/(?:json|json-seq|jsonl|x-jsonlines|xml|(?:x-)?javascript|(?:x-)?ecmascript|x-www-form-urlencoded|x-ndjson|graphql|graphql-response\+json|ld\+json|(?:x-)?yaml|(?:x-)?toml|(?:x-)?csv|(?:x-)?sql|x-sh|x-httpd-php|(?:x-)?tex|rtf|.*\+json|.*\+xml|.*\+yaml|.*\+toml)|image\/svg\+xml)/i;

/**
 * A decoder for the response's declared charset (`text/plain; charset=iso-8859-1`).
 * No charset, or a label the Encoding Standard does not know, decodes as UTF-8.
 */
export function textDecoderFor(contentType: string | null | undefined): TextDecoder {
  const match = contentType ? /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType) : null;
  const label = match?.[1];
  if (label) {
    try {
      return new TextDecoder(label);
    } catch {
      // Unknown label: fall through to UTF-8.
    }
  }
  return new TextDecoder();
}

/**
 * Read a header value (case-insensitively) from the sanitised header record.
 * `sanitizeResponseHeaders` preserves upstream key casing, so a plain
 * `headers['content-type']` lookup is not reliable across backends.
 */
export function getHeaderCI(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) return headers[key];
  }
  return undefined;
}

/** True when a content type should be transported as base64 binary, not text. */
export function isBinaryContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const essence = contentType.split(';')[0]?.trim().toLowerCase();
  if (!essence) return false;
  return !TEXT_CONTENT_TYPE_RE.test(essence);
}

/**
 * Base64-encode bytes without blowing the call stack on large buffers.
 * `String.fromCharCode(...bytes)` overflows the argument limit for big arrays,
 * so we chunk. `btoa` exists in both target runtimes.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000; // 32k — comfortably under the spread-arg limit
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Drain a Web ReadableStream into a single Uint8Array, enforcing a byte cap.
 * Returns `null` (after cancelling the stream) when the cap is exceeded so the
 * caller can surface a 413 instead of buffering an unbounded body.
 */
export async function readStreamToBytes(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** A response-like object: a body stream when the runtime surfaces one, else `text()`. */
export interface BoundedReadable {
  body?: ReadableStream<Uint8Array> | null;
  text: () => Promise<string>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
}

/**
 * Read a response body as text without buffering more than `maxBytes`, decoded
 * with the charset `contentType` declares (UTF-8 when none or unknown).
 * Streams when a body stream is available — cancelling the upstream the moment
 * the cap is crossed, so a chunked (no content-length) body can't grow the
 * isolate's memory unbounded. Falls back to `text()` + a length check only for
 * fetchers that expose no stream. Returns `null` when the body is oversize.
 */
export async function readBoundedText(
  response: BoundedReadable,
  maxBytes: number,
  contentType?: string | null
): Promise<{ text: string; bytes: number } | null> {
  if (response.body) {
    const bytes = await readStreamToBytes(response.body, maxBytes);
    if (bytes === null) return null;
    return { text: textDecoderFor(contentType).decode(bytes), bytes: bytes.byteLength };
  }
  if (response.arrayBuffer) {
    const buf = await response.arrayBuffer();
    if (buf.byteLength > maxBytes) return null;
    return { text: textDecoderFor(contentType).decode(buf), bytes: buf.byteLength };
  }
  const text = await response.text();
  const bytes = new TextEncoder().encode(text).byteLength;
  return bytes > maxBytes ? null : { text, bytes };
}
