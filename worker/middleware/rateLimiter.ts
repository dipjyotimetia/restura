import type { Context, Next } from 'hono';
import type { Env } from '../index';

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 100;

// Per-isolate sliding window — resets when the isolate is evicted (typically every few minutes).
// Good enough for burst protection. For cross-datacenter enforcement, provision a Cloudflare
// Rate Limiting namespace and set RATE_LIMITER in wrangler.jsonc.
const requestLog = new Map<string, number[]>();

function pruneOldEntries(now: number): void {
  const cutoff = now - WINDOW_MS;
  for (const [key, timestamps] of requestLog) {
    const recent = timestamps.filter((t) => t > cutoff);
    if (recent.length === 0) {
      requestLog.delete(key);
    } else {
      requestLog.set(key, recent);
    }
  }
}

export async function rateLimitMiddleware(c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> {
  const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? 'unknown';

  const now = Date.now();
  pruneOldEntries(now);

  const timestamps = requestLog.get(ip) ?? [];
  const windowStart = now - WINDOW_MS;
  const recentCount = timestamps.filter((t) => t > windowStart).length;

  if (recentCount >= MAX_REQUESTS) {
    return c.json({ error: 'Rate limit exceeded. Maximum 100 requests per minute.' }, 429);
  }

  timestamps.push(now);
  requestLog.set(ip, timestamps);

  return next();
}
