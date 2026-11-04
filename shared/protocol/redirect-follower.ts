import { isSecretFieldName } from '../secrets/key-value-redaction';
import { extractSetCookies } from './header-policy';
import { applyChainCookies, type RedirectCookieChain } from './set-cookie';
import type { Fetcher, FetcherRequest, FetcherResponse } from './types';
import { validateURL } from './url-validation';

/**
 * Manual redirect follower for the shared HTTP proxy. The Worker and Electron
 * fetchers MUST use `redirect: 'manual'` so we get a chance to validate every
 * hop — otherwise an attacker-controlled `Location: http://169.254.169.254/...`
 * is followed straight to the cloud metadata service, bypassing the URL guards
 * that were only ever applied to the initial URL.
 *
 * Policy enforced here:
 * - Every hop's target URL is re-validated via `validateURL` with the same
 *   private/localhost policy as the initial request.
 * - `Authorization`, `Cookie`, `Proxy-Authorization`, credential-named headers
 *   and the headers named by `stripOnOriginChange` are stripped on cross-origin
 *   redirects. Other headers keep following.
 * - 303 always rewrites to GET; 301/302 rewrite to GET when the original
 *   method wasn't HEAD (matches widespread real-world behavior even though
 *   RFC 9110 calls for method preservation); 307/308 preserve method.
 * - At most `MAX_REDIRECTS` hops; throws afterwards.
 *
 * Throws on policy violation. The caller (`executeHttpProxy`) translates the
 * thrown error to its existing `{ ok: false, status: 400, payload }` envelope.
 */

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_STRIPPED_ON_CROSS_ORIGIN: ReadonlyArray<string> = ['cookie', 'proxy-authorization'];

// Run-together spellings, for names that reach here lowercased (a `Headers` object
// has lost the case `isSecretFieldName` would split on).
const RUN_TOGETHER_CREDENTIAL_NAMES = new Set([
  'accesstoken',
  'apitoken',
  'authtoken',
  'clientsecret',
  'idtoken',
  'refreshtoken',
  'securitytoken',
  'sessiontoken',
]);

function isCredentialHeaderName(name: string): boolean {
  return (
    isSecretFieldName(name) ||
    name
      .toLowerCase()
      .split(/[-_.\s]+/)
      .some((segment) => RUN_TOGETHER_CREDENTIAL_NAMES.has(segment))
  );
}

/**
 * The credential headers of a request, judged on the case it was written in. Later
 * hops only see lowercased names. Authorization is left to `followAuthHeader`.
 */
export function credentialHeaderNames(headers: FetcherRequest['headers']): string[] {
  const names = headers instanceof Headers ? [...headers.keys()] : Object.keys(headers);
  return names
    .filter(isCredentialHeaderName)
    .map((name) => name.toLowerCase())
    .filter((name) => name !== 'authorization');
}

/**
 * Distinguishes a redirect-policy violation (blocked target, too many hops,
 * invalid Location) from a generic transport error. `executeHttpProxy` maps
 * this class to `{ ok: false, status: 400, payload }` so the client sees a
 * clear client-error, not a 502.
 */
export class RedirectPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedirectPolicyError';
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isRedirect(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}

function getLocationHeader(headers: FetcherResponse['headers']): string | null {
  if (headers instanceof Headers) {
    return headers.get('location');
  }
  // Plain object: case-insensitive lookup
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'location') {
      return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
    }
  }
  return null;
}

function headersFromRequest(req: FetcherRequest): Headers {
  if (req.headers instanceof Headers) {
    return new Headers(req.headers);
  }
  return new Headers(req.headers);
}

export interface FollowRedirectsOptions {
  allowLocalhost: boolean;
  /**
   * Permit redirects to RFC 1918 / link-local / CGNAT targets. Off by default;
   * self-hosted enterprise deployments may opt in. See SELF_HOSTING.md for
   * the DNS-rebind caveats.
   */
  allowPrivateIPs?: boolean;
  /**
   * If true, 301/302 redirects preserve the original method (RFC 9110
   * compliant). Default: false (legacy: non-HEAD → GET on 301/302). 303
   * always rewrites to GET regardless of this flag — that's universal HTTP
   * semantics, not opt-in.
   */
  followOriginalMethod?: boolean;
  /**
   * If true, the Authorization header is preserved on cross-origin redirects.
   * Cookie and Proxy-Authorization are always stripped cross-origin —
   * preserving those would leak credentials to arbitrary upstreams.
   * Default: false (Authorization stripped, matching curl's default).
   */
  followAuthHeader?: boolean;
  /** Further header names to strip on an origin change, whatever they are called. */
  stripOnOriginChange?: readonly string[];
  /**
   * If true, the Referer header is removed on every redirect hop (regardless
   * of origin). Default: false.
   */
  stripReferer?: boolean;
  /**
   * Override the default redirect hop cap (5). A positive value is clamped to
   * >= 1; `0` is special-cased to mean "do not follow redirects at all" (the
   * 3xx response is returned as-is). Omit to use the default.
   */
  maxRedirects?: number;
  /**
   * Hops already spent earlier in the same logical request — the Digest
   * challenge/retry continues the original chain, so it shares one budget
   * instead of getting a fresh `maxRedirects`.
   */
  hopsUsed?: number;
  /**
   * Records every response's Set-Cookie against the URL that sent it, and sends
   * the cookies a 3xx set on the hops after it (merged under any Cookie header
   * that survived the origin-change strip; explicit names win). Absent → no
   * cookie handling, as before.
   */
  cookieChain?: RedirectCookieChain;
}

/** Fields that describe a request body; they go when a redirect drops the body. */
const BODY_HEADER_NAMES = [
  'content-type',
  'content-length',
  'content-encoding',
  'content-language',
  'content-location',
];

export async function followRedirects(
  initialReq: FetcherRequest,
  fetcher: Fetcher,
  options: FollowRedirectsOptions
): Promise<FetcherResponse> {
  let req = initialReq;
  let response = await fetcher(req);
  let hops = options.hopsUsed ?? 0;
  const chain = options.cookieChain;
  chain?.record(req.url, extractSetCookies(response.headers), Date.now());

  // maxRedirects: 0 means "do not follow" — return the 3xx response unfollowed
  // (parity with axios `maxRedirects: 0` and the browser interactive path, so a
  // user who turns OFF "Follow redirects" actually sees the 3xx). There is no
  // target to re-validate because we never leave the origin response.
  if (options.maxRedirects === 0) {
    return response;
  }

  const maxHops = Math.max(1, options.maxRedirects ?? DEFAULT_MAX_REDIRECTS);
  const named = new Set([
    ...DEFAULT_STRIPPED_ON_CROSS_ORIGIN,
    ...(options.stripOnOriginChange ?? []).map((name) => name.toLowerCase()),
    ...credentialHeaderNames(initialReq.headers),
  ]);
  // followAuthHeader opts out of the name match for Authorization only; a header
  // the spec names explicitly still goes.
  const stripOnOriginChange = (name: string) =>
    named.has(name) ||
    (isCredentialHeaderName(name) && !(name === 'authorization' && options.followAuthHeader));

  // Every 3xx we do not return is released before moving on: an unread body
  // pins its connection (workerd caps concurrent subrequests at 6; undici holds
  // the pooled socket) for the rest of the chain.
  try {
    while (isRedirect(response.status)) {
      const next = nextHop(req, response, hops, maxHops, stripOnOriginChange, options);
      if (!next) break;
      if (chain) withChainCookies(next, chain);
      await discardBody(response);
      response = await fetcher(next);
      chain?.record(next.url, extractSetCookies(response.headers), Date.now());
      req = next;
      hops++;
    }
  } catch (error) {
    await discardBody(response);
    throw error;
  }

  return response;
}

/**
 * Apply the chain's cookies for the hop's URL to its (already origin-stripped)
 * Cookie header: a cookie set (or deleted) by an earlier hop of this chain wins
 * over the same-named pair the request started with, as a browser would send it.
 */
function withChainCookies(next: FetcherRequest, chain: RedirectCookieChain): void {
  const cookies = chain.matching(next.url, Date.now());
  const deleted = chain.deletedNames(next.url);
  if (cookies.length === 0 && deleted.size === 0) return;
  const headers = next.headers instanceof Headers ? next.headers : new Headers(next.headers);
  const merged = applyChainCookies(headers.get('cookie') ?? undefined, cookies, deleted);
  if (merged === '') headers.delete('cookie');
  else headers.set('cookie', merged);
  next.headers = headers;
}

/** Best-effort cancel of a response body the caller will never read. */
export async function discardBody(response: FetcherResponse): Promise<void> {
  try {
    if (response.body) await response.body.cancel();
  } catch {
    // Best effort — the stream may already be closed.
  }
}

/**
 * The request for the hop `response` redirects to, or `undefined` when it has
 * no `Location` (the 3xx is then the final response). Throws on policy violations.
 */
function nextHop(
  req: FetcherRequest,
  response: FetcherResponse,
  hops: number,
  maxHops: number,
  stripOnOriginChange: (name: string) => boolean,
  options: FollowRedirectsOptions
): FetcherRequest | undefined {
  if (hops >= maxHops) {
    throw new RedirectPolicyError(`Too many redirects (>${maxHops})`);
  }
  const location = getLocationHeader(response.headers);
  if (!location) return undefined;

  let nextUrl: string;
  try {
    nextUrl = new URL(location, req.url).toString();
  } catch {
    throw new RedirectPolicyError(`Invalid redirect Location header: ${location}`);
  }

  const nextValidation = validateURL(nextUrl, {
    allowPrivateIPs: options.allowPrivateIPs === true,
    allowLocalhost: options.allowLocalhost,
  });
  if (!nextValidation.valid) {
    throw new RedirectPolicyError(
      `Redirect blocked: ${nextValidation.error ?? 'invalid URL'} (private/internal target)`
    );
  }

  const fromOrigin = new URL(req.url).origin;
  const toOrigin = new URL(nextUrl).origin;
  const headers = headersFromRequest(req);
  if (fromOrigin !== toOrigin) {
    for (const name of [...headers.keys()]) {
      if (stripOnOriginChange(name)) headers.delete(name);
    }
  }
  if (options.stripReferer) {
    headers.delete('referer');
  }

  // 303 always rewrites to GET (universal HTTP semantics — POST/PUT result
  // pointing to a GET-able resource). 301/302 historically downgrade
  // non-HEAD to GET; followOriginalMethod opts into RFC-compliant
  // preservation. 307/308 always preserve method.
  const nextMethod =
    response.status === 303
      ? 'GET'
      : (response.status === 301 || response.status === 302) &&
          req.method !== 'HEAD' &&
          !options.followOriginalMethod
        ? 'GET'
        : req.method;

  // 307/308 preserve method; method-changing redirects drop the body — and the
  // headers that described it, or the GET goes out with an orphan Content-Type.
  const preservesBody = nextMethod === req.method;
  if (!preservesBody) {
    for (const name of BODY_HEADER_NAMES) headers.delete(name);
  }

  return {
    ...req,
    url: nextUrl,
    method: nextMethod,
    headers,
    body: preservesBody ? req.body : undefined,
  };
}
