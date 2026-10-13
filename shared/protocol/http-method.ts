/**
 * HTTP method policy (#857) — single source of truth for every harness
 * (Worker, Node self-host, Electron, CLI) and for import/persist validation.
 *
 * RFC 9110 §9.1: methods are an extensible `token` set, case-sensitive.
 * Restura accepts any token and sends it verbatim, except:
 *  - the seven well-known methods are normalised to upper case (so a stored
 *    `post` still goes out as `POST`, matching fetch's own normalisation);
 *  - CONNECT, TRACE and TRACK are denied in every casing — CONNECT would turn
 *    the proxy into a raw tunnel; TRACE (and IIS's TRACK alias) reflect request
 *    headers (incl. credentials) back to the caller (cross-site tracing).
 */

export const KNOWN_HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'OPTIONS',
  'HEAD',
] as const;

export type KnownHttpMethod = (typeof KNOWN_HTTP_METHODS)[number];

/** RFC 9110 §5.6.2 `token` (tchar+). */
export const HTTP_METHOD_TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Practical cap — no registered method is anywhere near this long. */
export const MAX_HTTP_METHOD_LENGTH = 64;

/** Refused in every casing (see module doc). */
export const DENIED_HTTP_METHODS = ['CONNECT', 'TRACE', 'TRACK'] as const;

const DENIED_METHODS: ReadonlySet<string> = new Set(DENIED_HTTP_METHODS);
const KNOWN_SET: ReadonlySet<string> = new Set(KNOWN_HTTP_METHODS);

export function isHttpMethodToken(method: string): boolean {
  return method.length <= MAX_HTTP_METHOD_LENGTH && HTTP_METHOD_TOKEN_RE.test(method);
}

export function isDeniedHttpMethod(method: string): boolean {
  return DENIED_METHODS.has(method.toUpperCase());
}

export function isKnownHttpMethod(method: string): method is KnownHttpMethod {
  return KNOWN_SET.has(method);
}

/**
 * True when `method` is sendable AND already in canonical wire form (known
 * methods upper-case, extension tokens as-is) — for persisted documents that
 * must match a stored request's method exactly (e.g. OWS binding calls).
 */
export function isCanonicalHttpMethod(method: string): boolean {
  const check = checkHttpMethod(method);
  return check.ok && check.method === method;
}

/**
 * Canonical wire form: known methods upper-cased, extension methods verbatim.
 * Does not validate — pair with {@link checkHttpMethod}.
 */
export function normalizeHttpMethod(method: string): string {
  const upper = method.toUpperCase();
  return KNOWN_SET.has(upper) ? upper : method;
}

export type HttpMethodCheck = { ok: true; method: string } | { ok: false; error: string };

/** Validate + normalise a method for sending. */
export function checkHttpMethod(raw: string): HttpMethodCheck {
  if (!isHttpMethodToken(raw)) {
    return { ok: false, error: `Method ${JSON.stringify(raw)} is not a valid HTTP method token` };
  }
  if (isDeniedHttpMethod(raw)) {
    return { ok: false, error: `Method ${raw.toUpperCase()} is not allowed` };
  }
  return { ok: true, method: normalizeHttpMethod(raw) };
}
