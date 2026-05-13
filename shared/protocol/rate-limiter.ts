import type { Context, Next } from 'hono';

// Per-isolate sliding window. Good enough for burst protection; for cross-datacenter
// enforcement provision a Cloudflare Rate Limiting namespace instead.
export function createRateLimiter(
  maxRequests = 100,
  windowMs = 60_000,
  pruneIntervalMs = 5_000,
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
    // CF-Connecting-IP is set by Cloudflare and cannot be spoofed by clients.
    const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
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
        { 'Retry-After': '60' },
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
