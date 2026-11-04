/**
 * The renderer cookie jar's RFC 6265 rules, kept pure so they unit-test without
 * the store: which Set-Cookie fields a response may store (and against which
 * URL), which stored cookies a request carries, and how they join a Cookie
 * header the user may have written themselves.
 *
 * Parsing and the per-cookie rules (Max-Age over Expires, Domain must
 * domain-match the request host, host-only cookies, default path) live in
 * `@shared/protocol/set-cookie` so the proxy's per-request redirect chain uses
 * the same ones. The jar adds the public-suffix check, which needs a suffix list.
 */
import {
  type CookieHop,
  cookieMatchesUrl,
  mergeCookieHeader,
  resolveSetCookie,
} from '@shared/protocol/set-cookie';
import { getPublicSuffix } from 'tough-cookie';

/** A stored cookie (persisted shape; see useCookieStore). */
export interface CookieItem {
  id: string;
  key: string;
  value: string;
  domain: string;
  path: string;
  expires?: string;
  secure: boolean;
  httpOnly: boolean;
  /**
   * Set from a response without a Domain attribute: sent to `domain` only, never
   * to its subdomains (RFC 6265 §5.3 step 6). Absent on cookies stored before
   * the flag existed and on hand-made cookies, which keep matching subdomains.
   */
  hostOnly?: boolean;
  lastAccessed?: string;
}

// PSL lookup tuned for an API client used heavily against local runtimes:
// allowSpecialUseDomain keeps `localhost` a valid registrable name, and
// ignoreError makes special-use/IP hosts return undefined instead of throwing.
const PUBLIC_SUFFIX_OPTIONS = { allowSpecialUseDomain: true, ignoreError: true } as const;

function isPublicSuffix(domain: string): boolean {
  return !getPublicSuffix(domain, PUBLIC_SUFFIX_OPTIONS);
}

function expiryMs(cookie: Pick<CookieItem, 'expires'>): number | undefined {
  if (!cookie.expires) return undefined;
  const at = new Date(cookie.expires).getTime();
  return Number.isNaN(at) ? undefined : at;
}

function sameIdentity(a: Pick<CookieItem, 'key' | 'domain' | 'path'>, b: typeof a): boolean {
  return a.key === b.key && a.domain === b.domain && a.path === b.path;
}

/**
 * Store every hop's Set-Cookie fields against the URL that sent them, in order,
 * and return the updated jar. A field is skipped when RFC 6265 §5.3 says to
 * ignore it (Domain that does not domain-match the host, or a public suffix);
 * `Max-Age<=0` or a past `Expires` deletes the stored cookie it names.
 */
export function applySetCookies(
  jar: readonly CookieItem[],
  hops: readonly CookieHop[],
  now: number,
  makeId: () => string
): CookieItem[] {
  let next = [...jar];
  for (const hop of hops) {
    for (const raw of hop.setCookies) {
      const resolved = resolveSetCookie(raw, hop.url, now);
      if (!resolved.ok) continue;
      const c = resolved.cookie;
      if (!c.hostOnly && isPublicSuffix(c.domain)) continue;

      const identity = { key: c.name, domain: c.domain, path: c.path };
      const existing = next.find((x) => sameIdentity(x, identity));
      next = next.filter((x) => !sameIdentity(x, identity));
      if (c.expiresAt !== undefined && c.expiresAt <= now) continue;

      next.push({
        id: existing?.id ?? makeId(),
        key: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        ...(c.expiresAt !== undefined ? { expires: new Date(c.expiresAt).toISOString() } : {}),
        secure: c.secure,
        httpOnly: c.httpOnly,
        hostOnly: c.hostOnly,
        lastAccessed: new Date(now).toISOString(),
      });
    }
  }
  return next;
}

/**
 * The hops a response's cookies belong to: the proxy's per-hop list when it
 * followed redirects, else the response's own cookies against `finalUrl` (or
 * the requested URL when the proxy reported none).
 */
export function responseCookieHops(
  response: { setCookies?: string[]; cookieHops?: CookieHop[]; finalUrl?: string },
  requestedUrl: string
): CookieHop[] {
  if (response.cookieHops && response.cookieHops.length > 0) return response.cookieHops;
  const setCookies = response.setCookies ?? [];
  if (setCookies.length === 0) return [];
  return [{ url: response.finalUrl ?? requestedUrl, setCookies }];
}

/** Stored cookies a request to `url` carries, longest path first (RFC 6265 §5.4). */
export function cookiesForUrl(jar: readonly CookieItem[], url: string, now: number): CookieItem[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  const host = parsed.hostname.toLowerCase();
  return jar
    .filter((cookie) => {
      const domain = cookie.domain.replace(/^\./, '').toLowerCase();
      // Public-suffix guard (RFC 6265 §5.3): a cookie scoped to a bare public
      // suffix (`com`, `co.uk`) never leaks to every site under it; it is only
      // ever sent back to that exact host.
      if (isPublicSuffix(domain) && host !== domain) return false;
      const at = expiryMs(cookie);
      return cookieMatchesUrl(
        {
          domain,
          hostOnly: cookie.hostOnly === true,
          path: cookie.path || '/',
          secure: cookie.secure,
          ...(at !== undefined ? { expiresAt: at } : {}),
        },
        parsed,
        now
      );
    })
    .sort((a, b) => (b.path || '/').length - (a.path || '/').length);
}

/**
 * `headers` with the jar's cookies joined into its Cookie header. The header is
 * found in any casing; cookies the user wrote there win on a name conflict and
 * the jar adds only the names they do not carry.
 */
export function withJarCookies(
  headers: Record<string, string>,
  jarCookies: ReadonlyArray<Pick<CookieItem, 'key' | 'value'>>
): Record<string, string> {
  if (jarCookies.length === 0) return headers;
  const name = Object.keys(headers).find((k) => k.toLowerCase() === 'cookie') ?? 'Cookie';
  const merged = mergeCookieHeader(
    headers[name],
    jarCookies.map((c) => ({ name: c.key, value: c.value }))
  );
  return { ...headers, [name]: merged };
}
