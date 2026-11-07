import type { Context, Next } from 'hono';

/**
 * Cloudflare Rate Limiting binding shape. Declared inline so we don't pull in
 * `@cloudflare/workers-types` from the shared protocol layer (kept runtime-
 * agnostic per CLAUDE.md). Wrangler injects this binding when
 * `unsafe.bindings.type=ratelimit` is declared in wrangler.jsonc.
 */
export interface RateLimitBinding {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

declare module 'hono' {
  interface ContextVariableMap {
    /**
     * Who the host's auth middleware authenticated the request as (e.g. the
     * proxy-token principal or a CF Access subject). Never a raw client header:
     * a client-chosen value would let each request open a fresh bucket.
     * Unset means anonymous.
     */
    authPrincipal: string;
    /**
     * Transport-level client address, set by a host whose forwarding headers
     * are not trustworthy (self-host Node without TRUST_PROXY=true). When set
     * it wins over every IP header.
     */
    clientIp: string;
  }
}

/**
 * Bucket key composition: `${ip}|${principal}`.
 *
 * The principal is what the auth middleware stashed on `authPrincipal`
 * (`anon` when unset). The IP is the host-supplied `clientIp` when present,
 * else `CF-Connecting-IP`, `True-Client-IP`, dev-only `X-Real-IP`, then a
 * UA-derived hash — it NEVER collapses to a single shared `'unknown'` bucket,
 * which would let one noisy client exhaust the limit for everyone.
 */
export function buildBucketKey(c: Context): string {
  const principal: string | undefined = c.get('authPrincipal');
  return `${resolveClientIp(c)}|${principal ?? 'anon'}`;
}

function resolveClientIp(c: Context): string {
  const socketIp: string | undefined = c.get('clientIp');
  if (socketIp) return socketIp;
  const cf = c.req.header('CF-Connecting-IP');
  if (cf) return cf;
  const trueClient = c.req.header('True-Client-IP');
  if (trueClient) return trueClient;
  // Dev-only X-Real-IP: tests / local proxies may set it. Never trust in prod.
  const env = (c.env ?? {}) as { ENVIRONMENT?: string; DEV_BYPASS_AUTH?: string };
  if (env.ENVIRONMENT === 'development' || env.DEV_BYPASS_AUTH === 'true') {
    const realIp = c.req.header('X-Real-IP');
    if (realIp) return realIp;
  }
  // No client IP at all → derive a per-connection identifier from headers the
  // browser can't easily collude on. Never collapse all unknowns to one bucket.
  const fp = c.req.header('Sec-WebSocket-Key') ?? c.req.header('User-Agent') ?? '';
  if (fp) return `noip:${djb2Hash(fp)}`;
  // Worst case: unique per request (effectively unmetered). Logged below.
  return `noip:${crypto.randomUUID()}`;
}

// Fast sync hash for the no-IP fingerprint path. Only reached when no client
// address exists at all (self-host pins the socket peer; Cloudflare sets
// CF-Connecting-IP), so a djb2 collision merges two address-less clients into
// one bucket in the worst case — never into a client that has an address.
function djb2Hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

/**
 * Binding-backed limiter. Free, sub-ms, colo-distributed. Bucket key is the
 * composite from `buildBucketKey`. `shadow: true` calls the binding but never
 * blocks — used to validate counts against the legacy isolate limiter before
 * flipping production.
 */
export function createBindingRateLimiter(
  binding: RateLimitBinding,
  opts: { shadow?: boolean } = {}
) {
  async function middleware(c: Context, next: Next): Promise<Response | void> {
    const key = buildBucketKey(c);
    const result = await binding.limit({ key });
    if (!result.success) {
      if (opts.shadow) {
        // Single-line JSON for `wrangler tail` correlation. No bucket key:
        // it carries the client address and the Access subject, which stay
        // out of logs.
        console.log(JSON.stringify({ kind: 'ratelimit.shadow-deny', ts: Date.now() }));
        return next();
      }
      return c.json({ error: 'Rate limit exceeded. Maximum 100 requests per minute.' }, 429, {
        'Retry-After': '60',
      });
    }
    return next();
  }
  return { middleware };
}

// Per-isolate sliding window. Good enough for burst protection; for cross-datacenter
// enforcement provision a Cloudflare Rate Limiting namespace instead.
export function createIsolateRateLimiter(
  maxRequests = 100,
  windowMs = 60_000,
  pruneIntervalMs = 5_000
) {
  const requestLog = new Map<string, number[]>();
  let lastPrune = 0;

  function pruneOldEntries(now: number): void {
    const cutoff = now - windowMs;
    for (const [key, timestamps] of requestLog) {
      const recent = timestamps.filter((t) => t > cutoff);
      if (recent.length === 0) {
        requestLog.delete(key);
      } else if (recent.length < timestamps.length) {
        requestLog.set(key, recent);
      }
    }
  }

  async function middleware(c: Context, next: Next): Promise<Response | void> {
    // Same composite key as the binding path (`buildBucketKey`). On self-host
    // Node the host pins `clientIp` to the socket peer unless TRUST_PROXY=true,
    // so client-sent forwarding headers cannot choose the bucket.
    const ip = buildBucketKey(c);
    const now = Date.now();
    if (now - lastPrune > pruneIntervalMs) {
      pruneOldEntries(now);
      lastPrune = now;
    }
    // Prune this client's own log against the window on every check: the
    // global sweep only runs every `pruneIntervalMs`, and relying on it alone
    // kept a client blocked for up to that long after its window had passed.
    const cutoff = now - windowMs;
    const timestamps = (requestLog.get(ip) ?? []).filter((t) => t > cutoff);
    if (timestamps.length >= maxRequests) {
      requestLog.set(ip, timestamps);
      return c.json(
        { error: `Rate limit exceeded. Maximum ${maxRequests} requests per minute.` },
        429,
        { 'Retry-After': '60' }
      );
    }
    timestamps.push(now);
    requestLog.set(ip, timestamps);
    return next();
  }

  function reset(): void {
    requestLog.clear();
    lastPrune = 0;
  }

  return { middleware, reset };
}
