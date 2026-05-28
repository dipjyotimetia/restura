import { validateURL } from './url-validation';
import type { Fetcher, FetcherRequest, FetcherResponse } from './types';

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
 * - `Authorization`, `Cookie`, and `Proxy-Authorization` are stripped on
 *   cross-origin redirects (matches browser / curl --location-trusted=false
 *   behavior).
 * - 303 always rewrites to GET; 301/302 rewrite to GET when the original
 *   method wasn't HEAD (matches widespread real-world behavior even though
 *   RFC 9110 calls for method preservation); 307/308 preserve method.
 * - At most `MAX_REDIRECTS` hops; throws afterwards.
 *
 * Throws on policy violation. The caller (`executeHttpProxy`) translates the
 * thrown error to its existing `{ ok: false, status: 400, payload }` envelope.
 */

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_STRIPPED_ON_CROSS_ORIGIN: ReadonlyArray<string> = [
  'authorization',
  'cookie',
  'proxy-authorization',
];

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
  /**
   * If true, the Referer header is removed on every redirect hop (regardless
   * of origin). Default: false.
   */
  stripReferer?: boolean;
  /** Override the default redirect hop cap (5). Clamped to >= 1. */
  maxRedirects?: number;
}

export async function followRedirects(
  initialReq: FetcherRequest,
  fetcher: Fetcher,
  options: FollowRedirectsOptions
): Promise<FetcherResponse> {
  let req = initialReq;
  let response = await fetcher(req);
  let hops = 0;

  const maxHops = Math.max(1, options.maxRedirects ?? DEFAULT_MAX_REDIRECTS);
  // Compute the cross-origin strip list per call so feature flags can opt out
  // of the default Authorization strip (followAuthHeader).
  const crossOriginStrip: ReadonlyArray<string> = options.followAuthHeader
    ? DEFAULT_STRIPPED_ON_CROSS_ORIGIN.filter((h) => h !== 'authorization')
    : DEFAULT_STRIPPED_ON_CROSS_ORIGIN;

  while (isRedirect(response.status)) {
    if (hops >= maxHops) {
      throw new RedirectPolicyError(`Too many redirects (>${maxHops})`);
    }
    const location = getLocationHeader(response.headers);
    if (!location) break;

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
      for (const h of crossOriginStrip) headers.delete(h);
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

    // 307/308 preserve method; method-changing redirects drop the body.
    const preservesBody = nextMethod === req.method;

    const nextReq: FetcherRequest = {
      ...req,
      url: nextUrl,
      method: nextMethod,
      headers,
      body: preservesBody ? req.body : undefined,
    };

    response = await fetcher(nextReq);
    req = nextReq;
    hops++;
  }

  return response;
}
