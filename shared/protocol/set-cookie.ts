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

/**
 * Streaming-path side channel for a followed redirect chain: `finalUrl` and
 * every hop's Set-Cookie fields (see `NormalizedResponse.cookieHops`), so the
 * renderer's jar stores each hop's cookies against the URL that set them. The
 * value is `encodeURIComponent(JSON)` — always a valid header ByteString.
 * Absent when the first response was final.
 */
export const COOKIE_HOPS_SIDE_CHANNEL_HEADER = 'x-restura-cookie-hops';

export interface CookieHopsSideChannel {
  finalUrl?: string;
  cookieHops?: CookieHop[];
}

function encodeCookieHops(fields: CookieHopsSideChannel): string {
  return encodeURIComponent(JSON.stringify(fields));
}

/**
 * Encode `finalUrl` + the hops under `maxBytes`. Cookie fields that do not fit
 * are dropped (in order; a later smaller one may still ride) and counted in
 * `omitted`, like {@link buildSetCookieSideChannel}. `value` is undefined when
 * there is nothing to carry.
 */
export function buildCookieHopsSideChannel(
  fields: CookieHopsSideChannel,
  maxBytes: number = SET_COOKIE_SIDE_CHANNEL_MAX_BYTES
): { value: string | undefined; omitted: number } {
  if (fields.finalUrl === undefined && !fields.cookieHops?.length) {
    return { value: undefined, omitted: 0 };
  }
  const full = encodeCookieHops(fields);
  if (full.length <= maxBytes) return { value: full, omitted: 0 };
  const kept: CookieHop[] = [];
  let omitted = 0;
  const base: CookieHopsSideChannel = {
    ...(fields.finalUrl !== undefined ? { finalUrl: fields.finalUrl } : {}),
    cookieHops: kept,
  };
  for (const hop of fields.cookieHops ?? []) {
    const slot: CookieHop = { url: hop.url, setCookies: [] };
    kept.push(slot);
    for (const cookie of hop.setCookies) {
      slot.setCookies.push(cookie);
      if (encodeCookieHops(base).length > maxBytes) {
        slot.setCookies.pop();
        omitted++;
      }
    }
    if (slot.setCookies.length === 0) kept.pop();
  }
  const value = encodeCookieHops(base);
  return { value: value.length <= maxBytes ? value : undefined, omitted };
}

/** Decode {@link COOKIE_HOPS_SIDE_CHANNEL_HEADER}; anything malformed → `{}`. */
export function decodeCookieHopsSideChannel(
  value: string | null | undefined
): CookieHopsSideChannel {
  if (!value) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(value));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const raw = parsed as { finalUrl?: unknown; cookieHops?: unknown };
  const out: CookieHopsSideChannel = {};
  if (typeof raw.finalUrl === 'string') out.finalUrl = raw.finalUrl;
  if (Array.isArray(raw.cookieHops)) {
    const hops: CookieHop[] = [];
    for (const hop of raw.cookieHops) {
      const h = hop as { url?: unknown; setCookies?: unknown } | null;
      if (!h || typeof h.url !== 'string' || !Array.isArray(h.setCookies)) continue;
      const setCookies = h.setCookies.filter((c): c is string => typeof c === 'string');
      if (setCookies.length > 0) hops.push({ url: h.url, setCookies });
    }
    if (hops.length > 0) out.cookieHops = hops;
  }
  return out;
}

// ---------------------------------------------------------------------------
// RFC 6265 storage model (§5.1.3 domain match, §5.1.4 paths, §5.2/§5.3 storage)
// ---------------------------------------------------------------------------

/** A Set-Cookie field resolved against the URL that sent it (RFC 6265 §5.3). */
export interface ResolvedCookie {
  name: string;
  value: string;
  /** Lowercase host (host-only) or Domain attribute without its leading dot. */
  domain: string;
  /** True when the response carried no Domain attribute: only `domain` itself matches. */
  hostOnly: boolean;
  path: string;
  /**
   * Epoch ms when the cookie expires; absent for a session cookie. A value at or
   * before `now` means the response asked for the cookie to be deleted
   * (`Max-Age=0`, or an `Expires` in the past).
   */
  expiresAt?: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
}

export type CookieResolution = { ok: true; cookie: ResolvedCookie } | { ok: false; reason: string };

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function isIpHost(host: string): boolean {
  return IPV4_RE.test(host) || host.includes(':');
}

/** The request host as cookies compare it: lowercase, no IPv6 brackets or trailing dot. */
export function cookieHost(url: URL): string {
  return url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

/** RFC 6265 §5.1.3: `host` is `domain`, or a subdomain of it (never for IP hosts). */
export function cookieDomainMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase();
  if (h === d) return true;
  return !isIpHost(h) && h.endsWith(`.${d}`);
}

/** RFC 6265 §5.1.4: the directory of the request path (`/a/b/c` → `/a/b`, else `/`). */
export function defaultCookiePath(url: URL): string {
  const path = url.pathname;
  if (!path.startsWith('/')) return '/';
  const last = path.lastIndexOf('/');
  return last <= 0 ? '/' : path.slice(0, last);
}

/** RFC 6265 §5.1.4 path-match. */
export function cookiePathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath.charAt(cookiePath.length) === '/';
}

/**
 * Resolve one Set-Cookie field against the URL whose response carried it:
 * Max-Age wins over Expires (§5.3 step 3), a Domain attribute must domain-match
 * the request host or the cookie is ignored (§5.3 step 6), no Domain makes the
 * cookie host-only, and a missing or relative Path takes the default path.
 *
 * A single-label Domain (`Domain=com`) other than the host itself is refused
 * as a public-suffix stand-in; callers with a public suffix list (the
 * renderer's cookie jar) apply the full check on top.
 */
export function resolveSetCookie(raw: string, requestUrl: string, now: number): CookieResolution {
  const parsed = parseSetCookie(raw);
  if (!parsed) return { ok: false, reason: 'no name=value pair' };
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return { ok: false, reason: 'invalid request URL' };
  }
  const host = cookieHost(url);

  let domain = host;
  let hostOnly = true;
  const attr = parsed.domain?.trim().replace(/^\./, '').replace(/\.$/, '').toLowerCase();
  if (attr) {
    if (!cookieDomainMatches(host, attr)) {
      return { ok: false, reason: `Domain=${attr} does not match ${host}` };
    }
    if (attr !== host && !attr.includes('.')) {
      return { ok: false, reason: `Domain=${attr} is a public suffix` };
    }
    domain = attr;
    hostOnly = false;
  }

  const path = parsed.path?.startsWith('/') ? parsed.path : defaultCookiePath(url);

  let expiresAt: number | undefined;
  if (parsed.maxAge !== undefined) {
    const seconds = Math.trunc(parsed.maxAge);
    expiresAt = seconds <= 0 ? Number.NEGATIVE_INFINITY : now + seconds * 1000;
  } else if (parsed.expires) {
    const at = Date.parse(parsed.expires);
    if (!Number.isNaN(at)) expiresAt = at;
  }

  const cookie: ResolvedCookie = {
    name: parsed.name,
    value: parsed.value,
    domain,
    hostOnly,
    path,
    secure: parsed.secure === true,
    httpOnly: parsed.httpOnly === true,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(parsed.sameSite !== undefined ? { sameSite: parsed.sameSite } : {}),
  };
  return { ok: true, cookie };
}

/** True when a cookie is expired at `now`. */
export function isCookieExpired(cookie: Pick<ResolvedCookie, 'expiresAt'>, now: number): boolean {
  return cookie.expiresAt !== undefined && cookie.expiresAt <= now;
}

/** RFC 6265 §5.4: whether `cookie` goes on a request to `url`. */
export function cookieMatchesUrl(
  cookie: Pick<ResolvedCookie, 'domain' | 'hostOnly' | 'path' | 'secure' | 'expiresAt'>,
  url: URL,
  now: number
): boolean {
  if (isCookieExpired(cookie, now)) return false;
  const host = cookieHost(url);
  const domainOk = cookie.hostOnly
    ? host === cookie.domain.toLowerCase()
    : cookieDomainMatches(host, cookie.domain);
  if (!domainOk) return false;
  if (!cookiePathMatches(url.pathname || '/', cookie.path)) return false;
  return !cookie.secure || url.protocol === 'https:';
}

const cookiePairName = (pair: string) => (pair.split('=', 1)[0] ?? '').trim();

/**
 * Combine an explicit Cookie header with jar cookies: every name the header
 * already carries wins, the jar adds only the names it does not.
 */
export function mergeCookieHeader(
  explicit: string | undefined,
  jar: ReadonlyArray<{ name: string; value: string }>
): string {
  const pairs = (explicit ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  const named = new Set(pairs.map(cookiePairName));
  for (const c of jar) {
    if (named.has(c.name)) continue;
    named.add(c.name);
    pairs.push(`${c.name}=${c.value}`);
  }
  return pairs.join('; ');
}

/**
 * The Cookie header for the next hop of a redirect chain (browser semantics):
 * a cookie a hop of this chain set replaces the same-named pair in the
 * outgoing header (which carries the user's and the jar's cookies), and one a
 * hop deleted is dropped. Other pairs keep their place.
 */
export function applyChainCookies(
  outgoing: string | undefined,
  set: ReadonlyArray<{ name: string; value: string }>,
  deleted: ReadonlySet<string>
): string {
  // `set` is longest-path first: the first cookie of a name is the one sent.
  const byName = new Map<string, string>();
  for (const c of set) if (!byName.has(c.name)) byName.set(c.name, c.value);
  const pairs: string[] = [];
  const sent = new Set<string>();
  for (const pair of (outgoing ?? '').split(';')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const name = cookiePairName(trimmed);
    const replacement = byName.get(name);
    if (replacement === undefined) {
      if (!deleted.has(name)) pairs.push(trimmed);
      continue;
    }
    if (sent.has(name)) continue;
    sent.add(name);
    pairs.push(`${name}=${replacement}`);
  }
  for (const c of set) {
    if (sent.has(c.name)) continue;
    sent.add(c.name);
    pairs.push(`${c.name}=${c.value}`);
  }
  return pairs.join('; ');
}

/** The Set-Cookie fields one response of a redirect chain carried, with its URL. */
export interface CookieHop {
  url: string;
  setCookies: string[];
}

/**
 * Cookies set during one request's redirect chain (Postman/curl `-L -b` style):
 * a 3xx's Set-Cookie applies to the hops after it. Ephemeral — the renderer's
 * persistent jar is fed separately from the per-hop list.
 */
export class RedirectCookieChain {
  private cookies: ResolvedCookie[] = [];
  private deleted: ResolvedCookie[] = [];
  readonly hops: CookieHop[] = [];
  /** URL of the last response recorded — the final URL once the chain ends. */
  lastUrl: string | undefined;
  /** Responses recorded: more than one means a redirect (or Digest retry) happened. */
  responses = 0;

  record(url: string, setCookies: string[], now: number): void {
    this.lastUrl = url;
    this.responses++;
    if (setCookies.length > 0) this.hops.push({ url, setCookies });
    for (const raw of setCookies) {
      const r = resolveSetCookie(raw, url, now);
      if (!r.ok) continue;
      const c = r.cookie;
      const same = (x: ResolvedCookie) =>
        x.name === c.name && x.domain === c.domain && x.path === c.path;
      this.cookies = this.cookies.filter((x) => !same(x));
      this.deleted = this.deleted.filter((x) => !same(x));
      if (isCookieExpired(c, now)) this.deleted.push(c);
      else this.cookies.push(c);
    }
  }

  /**
   * Names of cookies a hop of this chain deleted (expired Set-Cookie) that
   * would match `url` and that no live chain cookie re-sets.
   */
  deletedNames(url: string): Set<string> {
    const out = new Set<string>();
    if (this.deleted.length === 0) return out;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return out;
    }
    for (const c of this.deleted) {
      // Match on scope only: the deletion itself is what expired it.
      const { expiresAt: _expired, ...scope } = c;
      if (cookieMatchesUrl(scope, parsed, Number.NEGATIVE_INFINITY)) out.add(c.name);
    }
    return out;
  }

  /** Chain cookies for `url`, longest path first (RFC 6265 §5.4 step 2). */
  matching(url: string, now: number): ResolvedCookie[] {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return [];
    }
    return this.cookies
      .filter((c) => cookieMatchesUrl(c, parsed, now))
      .sort((a, b) => b.path.length - a.path.length);
  }
}
