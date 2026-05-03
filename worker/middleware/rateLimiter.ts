import type { Context, Next } from 'hono';
import type { Env } from '../index';

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 100;
const PRUNE_INTERVAL_MS = 5_000;

// Per-isolate sliding window — resets when the isolate is evicted (typically every few minutes).
// Good enough for burst protection. For cross-datacenter enforcement, provision a Cloudflare
// Rate Limiting namespace and set RATE_LIMITER in wrangler.jsonc.
const requestLog = new Map<string, number[]>();
let lastPrune = 0;

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
  // CF-Connecting-IP is set by Cloudflare and cannot be spoofed by clients.
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';

  const now = Date.now();
  if (now - lastPrune > PRUNE_INTERVAL_MS) {
    pruneOldEntries(now);
    lastPrune = now;
  }

  const timestamps = requestLog.get(ip) ?? [];
  // After pruning, all stored timestamps are already within the window.
  if (timestamps.length >= MAX_REQUESTS) {
    return c.json({ error: `Rate limit exceeded. Maximum ${MAX_REQUESTS} requests per minute.` }, 429);
  }

  timestamps.push(now);
  requestLog.set(ip, timestamps);

  return next();
}
