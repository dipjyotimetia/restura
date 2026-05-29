import type { z } from 'zod';

/**
 * Outcome of {@link parseJsonBody}. `ok: true` carries the parsed value;
 * `ok: false` carries an HTTP 400 status and a short human-readable error
 * string ready to surface in a JSON response envelope.
 *
 * The narrow status type (`400`) lets handlers feed this straight into
 * `c.json(payload, status)` without TypeScript widening the StatusCode union.
 */
export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 413; error: string };

/** Options for {@link parseJsonBody}. */
export interface ParseJsonBodyOptions {
  /**
   * Reject the request with 413 if its `Content-Length` exceeds this many
   * bytes, *before* the body is read into memory. Opt-in per call so the
   * proxy endpoint (50 MB request bodies) is unaffected; small public
   * endpoints (telemetry, ws-ticket) pass a tight cap. Best-effort: a request
   * without a `Content-Length` header (e.g. chunked) skips the pre-check and
   * is still bounded by the schema's own field `.max()`s after parse.
   */
  maxBytes?: number;
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
  if (options?.maxBytes !== undefined) {
    const declared = Number(req.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      return { ok: false, status: 413, error: 'Request body too large' };
    }
  }
  let raw: unknown;
  try {
    raw = await req.json();
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
