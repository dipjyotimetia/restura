import type { z } from 'zod';

/**
 * Outcome of {@link parseJsonBody}. `ok: true` carries the parsed value;
 * `ok: false` carries a 4xx status (400 for malformed/invalid JSON, 413 when
 * the `maxBytes` cap is exceeded) and a short human-readable error string
 * ready to surface in a JSON response envelope.
 *
 * The narrow status type (`400 | 413`) lets handlers feed this straight into
 * `c.json(payload, status)` without TypeScript widening the StatusCode union.
 */
export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 413; error: string };

/** Options for {@link parseJsonBody}. */
export interface ParseJsonBodyOptions {
  /**
   * Reject the request with 413 once its body exceeds this many bytes.
   * A declared `Content-Length` over the cap is refused before anything is
   * read; a chunked body (no `Content-Length`) is counted while it streams
   * and the read is cancelled the moment the cap is crossed, so nothing past
   * the cap is ever buffered. Defaults to {@link DEFAULT_MAX_JSON_BODY_BYTES};
   * small public endpoints (telemetry, ws-ticket) pass a tight cap.
   */
  maxBytes?: number;
}

/**
 * Cap applied when a route passes no `maxBytes`. Sized above the proxy's
 * largest legitimate envelope (a 50 MB `data` string plus headers / form
 * fields / JSON escaping) so it never refuses a request the schema accepts
 * in practice, while still bounding an endless chunked body.
 */
export const DEFAULT_MAX_JSON_BODY_BYTES = 64 * 1024 * 1024;

const TOO_LARGE = { ok: false, status: 413, error: 'Request body too large' } as const;

/**
 * Read a request body to bytes, refusing (and cancelling the stream) as soon
 * as more than `maxBytes` arrive. Returns `null` when the cap is exceeded.
 */
async function readBodyCapped(req: Request, maxBytes: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Read a JSON request body and validate it against a Zod schema. Handles
 * the two boundary failure modes a Worker must guard:
 *
 *   1. The body is not valid JSON (`req.json()` throws).
 *   2. The body parses as JSON but doesn't match the expected shape.
 *
 * Both cases return `{ ok: false, status: 400, error }` — never a 500.
 * The handler keeps its 5xx slots for upstream/runtime failures.
 *
 * This is the symmetric counterpart to Electron's `validateIpcInput`. With
 * both boundaries enforced, the renderer is the only place that can ever
 * speak a "trusted" wire shape into the protocol core.
 */
export async function parseJsonBody<T>(
  req: Request,
  schema: z.ZodType<T>,
  options?: ParseJsonBodyOptions
): Promise<ParseResult<T>> {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_JSON_BODY_BYTES;
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return TOO_LARGE;
  let bytes: Uint8Array | null;
  try {
    bytes = await readBodyCapped(req, maxBytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unreadable body';
    return { ok: false, status: 400, error: `Malformed JSON: ${message}` };
  }
  if (bytes === null) return TOO_LARGE;
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid JSON';
    return { ok: false, status: 400, error: `Malformed JSON: ${message}` };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    return { ok: false, status: 400, error: `Invalid request body: ${message}` };
  }
  return { ok: true, value: parsed.data };
}

/**
 * True when a `Content-Type` header names `application/json` (parameters such
 * as `; charset=utf-8` allowed, case-insensitive). Anything else — including
 * `text/plain`, form encodings, a missing header, or look-alikes such as
 * `application/jsonp` — is false.
 *
 * Why it matters (CSRF): `text/plain`, `application/x-www-form-urlencoded` and
 * `multipart/form-data` are CORS "simple" types, so a hostile page can POST
 * them cross-origin WITHOUT a preflight. `req.json()` happily parses such a
 * body, so a JSON route that does not check the type can be driven by any
 * website. Insisting on `application/json` forces the browser to preflight,
 * and the CORS allowlist then refuses the foreign origin.
 */
export function isJsonContentType(header: string | null | undefined): boolean {
  if (!header) return false;
  const mediaType = header.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'application/json';
}
