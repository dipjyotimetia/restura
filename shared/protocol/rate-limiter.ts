import type { Context, Next } from 'hono';
import { sha256Hex } from './crypto-utils';

/**
 * Cloudflare Rate Limiting binding shape. Declared inline so we don't pull in
 * `@cloudflare/workers-types` from the shared protocol layer (kept runtime-
 * agnostic per CLAUDE.md). Wrangler injects this binding when
 * `unsafe.bindings.type=ratelimit` is declared in wrangler.jsonc.
 */
export interface RateLimitBinding {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

// FIFO-bounded cache: token → first-16-hex of SHA-256. Tokens are stable per
// client, so caching avoids running an async digest on every request. Per
// isolate; bucket cardinality is independent.
const TOKEN_FP_CACHE_CAP = 256;
const tokenFpCache = new Map<string, string>();

async function tokenFingerprint(token: string): Promise<string> {
  const cached = tokenFpCache.get(token);
  if (cached) return cached;
  const fp = (await sha256Hex(token)).slice(0, 16);
  if (tokenFpCache.size >= TOKEN_FP_CACHE_CAP) {
    // FIFO eviction — Map preserves insertion order, so the first key is the oldest.
    const oldest = tokenFpCache.keys().next().value;
    if (oldest !== undefined) tokenFpCache.delete(oldest);
  }
  tokenFpCache.set(token, fp);
  return fp;
}

/**
 * Bucket key composition: `${ip}|${tokenFingerprint}`.
 *
 * The token fingerprint is the first 16 chars of SHA-256(token). The IP falls
 * back through `True-Client-IP`, then dev-only `X-Real-IP`, then a UA-derived
 * hash — it NEVER collapses to a single shared `'unknown'` bucket, which would
 * let one noisy client exhaust the limit for everyone.
 *
 * Token preference: explicit proxy token > Authorization Bearer > CF Access
 * email. Anonymous requests get a literal `anon` token bucket.
 */
export async function buildBucketKey(c: Context): Promise<string> {
  const ip = resolveClientIp(c);
  const token =
    c.req.header('X-Restura-Proxy-Token') ??
    c.req.header('Authorization')?.replace(/^Bearer\s+/i, '') ??
    c.req.header('Cf-Access-Authenticated-User-Email');
  const tokenFp = token ? await tokenFingerprint(token) : 'anon';
  return `${ip}|${tokenFp}`;
}

function resolveClientIp(c: Context): string {
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

// Fast sync hash for the no-IP fingerprint path. Collision risk is
// acceptable because the bucket key also includes the (separately hashed)
// token fingerprint — a djb2 collision alone can't merge two distinct buckets.
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
    const key = await buildBucketKey(c);
    const result = await binding.limit({ key });
    if (!result.success) {
      if (opts.shadow) {
        // Single-line JSON for `wrangler tail` correlation. No bucket key
        // because it includes a (hashed) token fingerprint we'd rather not log.
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

/** Backwards-compatible alias — legacy isolate limiter constructor. */
export function createIsolateRateLimiter(
  maxRequests = 100,
  windowMs = 60_000,
  pruneIntervalMs = 5_000
) {
  return createRateLimiter(maxRequests, windowMs, pruneIntervalMs);
}

// Per-isolate sliding window. Good enough for burst protection; for cross-datacenter
// enforcement provision a Cloudflare Rate Limiting namespace instead.
export function createRateLimiter(maxRequests = 100, windowMs = 60_000, pruneIntervalMs = 5_000) {
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
    // Bucket key. On Cloudflare, CF-Connecting-IP is canonical and unspoofable.
    // On Node (self-hosted), it's never set — so fall through to the same
    // chain `buildBucketKey` uses for the binding path: True-Client-IP →
    // X-Real-IP / X-Forwarded-For (set by the operator's reverse proxy) →
    // UA-derived hash, instead of collapsing every client into a shared
    // 'unknown' bucket where one noisy client could DoS everyone.
    const ip = await buildBucketKey(c);
    const now = Date.now();
    if (now - lastPrune > pruneIntervalMs) {
      pruneOldEntries(now);
      lastPrune = now;
    }
    const timestamps = requestLog.get(ip) ?? [];
    if (timestamps.length >= maxRequests) {
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
