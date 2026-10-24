/**
 * Set-Cookie helpers shared by every harness (Worker, self-host, Electron,
 * renderer, CLI).
 *
 * RFC 6265 §3: Set-Cookie must never be list-combined for processing (cookie
 * attributes such as `Expires` contain commas), so responses carry the
 * authoritative `setCookies: string[]` (one entry per header field) next to the
 * flat `headers: Record<string, string>`. Every view — cookie jar, Headers
 * view, network console, scripts — derives from that list through here.
 */

/** A Set-Cookie header field parsed into its name/value and attributes. */
export interface ParsedSetCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: string;
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

/** Any response-ish object carrying the flat header map + the cookie list. */
export interface SetCookieSource {
  headers: Record<string, string | string[]>;
  setCookies?: string[] | undefined;
}

/**
 * Response header the Worker / self-host streaming path uses to carry every
 * upstream Set-Cookie to the renderer as a JSON array. Upstream `set-cookie`
 * is never forwarded as a real header — the browser would store the upstream
 * cookies on the Restura origin — so this is the only carrier.
 */
export const SET_COOKIE_SIDE_CHANNEL_HEADER = 'x-restura-set-cookies';

/**
 * Split a folded `Set-Cookie` value (several cookies comma-joined, as Node and
 * Fetch `Headers.get()` produce) back into fields. Splits only on commas that
 * precede a `name=` token so `Expires=Wed, 21 Oct …` stays intact.
 */
export function splitFoldedSetCookie(raw: string): string[] {
  return raw
    .split(/,(?=\s*[A-Za-z0-9!#$%&'*+\-.^_`|~]+\s*=)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function findHeader(
  headers: Record<string, string | string[]>,
  name: string
): string | string[] | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return v;
  }
  return undefined;
}

/**
 * Every Set-Cookie field on a response. `setCookies` is authoritative; the
 * flat `headers` map is only a fallback for responses captured before the list
 * existed (a folded value is split comma-aware).
 */
export function responseSetCookies(response: SetCookieSource): string[] {
  if (response.setCookies && response.setCookies.length > 0) return response.setCookies;
  const raw = findHeader(response.headers, 'set-cookie');
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw : splitFoldedSetCookie(raw);
}

/**
 * Header rows for display: one row per value, so each Set-Cookie field gets
 * its own row (sourced from `setCookies`, which the flat map can't represent).
 */
export function responseHeaderEntries(response: SetCookieSource): Array<[string, string]> {
  const cookies = responseSetCookies(response);
  const rows: Array<[string, string]> = [];
  let cookiesPlaced = false;
  for (const [key, value] of Object.entries(response.headers)) {
    if (key.toLowerCase() === 'set-cookie') {
      if (!cookiesPlaced) {
        for (const c of cookies) rows.push([key, c]);
        cookiesPlaced = true;
      }
      continue;
    }
    for (const v of Array.isArray(value) ? value : [value]) rows.push([key, v]);
  }
  if (!cookiesPlaced) for (const c of cookies) rows.push(['set-cookie', c]);
  return rows;
}

/**
 * The flat header map scripts see. `set-cookie` is always every cookie joined
 * with `", "` (Fetch `Headers.get()` semantics) whichever harness produced the
 * response, so `response.headers['set-cookie']` is deterministic across web,
 * self-host, desktop, and CLI. The individual fields stay available through
 * the cookie list.
 */
export function combineSetCookieHeader(
  headers: Record<string, string>,
  setCookies: string[] | undefined
): Record<string, string> {
  const cookies = responseSetCookies({ headers, setCookies });
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== 'set-cookie') out[k] = v;
  }
  if (cookies.length > 0) out['set-cookie'] = cookies.join(', ');
  return out;
}

/** Parse one Set-Cookie field. Returns null when there is no `name=` pair. */
export function parseSetCookie(raw: string): ParsedSetCookie | null {
  const parts = raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  const first = parts[0] ?? '';
  const eq = first.indexOf('=');
  const name = eq < 0 ? '' : first.slice(0, eq).trim();
  if (!name) return null;
  const out: ParsedSetCookie = { name, value: first.slice(eq + 1).trim() };
  for (const seg of parts.slice(1)) {
    const i = seg.indexOf('=');
    const key = (i < 0 ? seg : seg.slice(0, i)).trim().toLowerCase();
    const val = i < 0 ? '' : seg.slice(i + 1).trim();
    if (key === 'domain') out.domain = val;
    else if (key === 'path') out.path = val;
    else if (key === 'expires') out.expires = val;
    else if (key === 'max-age') {
      const n = Number(val);
      if (val !== '' && Number.isFinite(n)) out.maxAge = n;
    } else if (key === 'httponly') out.httpOnly = true;
    else if (key === 'secure') out.secure = true;
    else if (key === 'samesite') out.sameSite = val;
  }
  return out;
}

/** Parse every Set-Cookie field on a response, dropping unparseable ones. */
export function parseResponseSetCookies(response: SetCookieSource): ParsedSetCookie[] {
  return responseSetCookies(response)
    .map(parseSetCookie)
    .filter((c): c is ParsedSetCookie => c !== null);
}

/**
 * Encode the cookie list for {@link SET_COOKIE_SIDE_CHANNEL_HEADER}: JSON with
 * every code unit outside printable ASCII escaped, so the value is always a
 * valid header ByteString whatever bytes the upstream sent.
 */
export function encodeSetCookieSideChannel(cookies: string[]): string {
  return JSON.stringify(cookies).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

/**
 * Cap on the encoded side-channel header. Node's default max header size is
 * 16KB for the whole header block, so one header must stay well under it.
 */
export const SET_COOKIE_SIDE_CHANNEL_MAX_BYTES = 8 * 1024;

/** Carries the count of cookies dropped to honour the cap (absent when none). */
export const SET_COOKIE_OMITTED_HEADER = 'x-restura-set-cookies-omitted';

/**
 * Encode as many cookies as fit under `maxBytes` (in order; a cookie that
 * doesn't fit is skipped, later smaller ones may still ride) and report how
 * many were omitted so the renderer can tell the user.
 */
export function buildSetCookieSideChannel(
  cookies: string[],
  maxBytes: number = SET_COOKIE_SIDE_CHANNEL_MAX_BYTES
): { value: string; omitted: number } {
  const full = encodeSetCookieSideChannel(cookies);
  if (full.length <= maxBytes) return { value: full, omitted: 0 };
  const kept: string[] = [];
  let size = 2; // []
  for (const cookie of cookies) {
    const encoded = encodeSetCookieSideChannel([cookie]);
    const cost = encoded.length - 2 + (kept.length > 0 ? 1 : 0);
    if (size + cost <= maxBytes) {
      kept.push(cookie);
      size += cost;
    }
  }
  return { value: encodeSetCookieSideChannel(kept), omitted: cookies.length - kept.length };
}

/** Decode {@link SET_COOKIE_SIDE_CHANNEL_HEADER}; anything malformed → `[]`. */
export function decodeSetCookieSideChannel(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}
