/**
 * Rate-limit middleware switch (Gap #3). Defaults to the per-isolate Map
 * limiter for backwards-compatibility; switches to the Cloudflare Rate
 * Limiting binding (colo-distributed, free, sub-ms) when `RATE_LIMITER` is
 * set in wrangler.jsonc / .dev.vars.
 *
 * Shadow mode lets us compare binding decisions against the legacy limiter
 * before flipping enforcement in production.
 */

import type { Context, Next } from 'hono';
import {
  createBindingRateLimiter,
  createIsolateRateLimiter,
  type RateLimitBinding,
} from '@shared/protocol/rate-limiter';
import type { Env } from '../env';

const isolateLimiter = createIsolateRateLimiter();
export const resetRateLimiter = isolateLimiter.reset;

// Per-isolate memoisation: the binding limiter is a thin closure over the
// binding handle, so we instantiate it once per (binding, mode) pair instead
// of per request.
let cachedBinding: RateLimitBinding | undefined;
let cachedEnforce: ReturnType<typeof createBindingRateLimiter> | null = null;
let cachedShadow: ReturnType<typeof createBindingRateLimiter> | null = null;
let warnedMissingBinding = false;

function getBindingLimiter(
  binding: RateLimitBinding,
  shadow: boolean
): ReturnType<typeof createBindingRateLimiter> {
  if (binding !== cachedBinding) {
    cachedBinding = binding;
    cachedEnforce = null;
    cachedShadow = null;
  }
  if (shadow) {
    cachedShadow ??= createBindingRateLimiter(binding, { shadow: true });
    return cachedShadow;
  }
  cachedEnforce ??= createBindingRateLimiter(binding);
  return cachedEnforce;
}

export async function rateLimitMiddleware(
  c: Context<{ Bindings: Env }>,
  next: Next
): Promise<Response | void> {
  const mode = c.env.RATE_LIMITER ?? 'map';
  const binding = c.env.RATE_LIMITER_BINDING;

  if ((mode === 'binding' || mode === 'binding-shadow') && !binding && !warnedMissingBinding) {
    console.warn(
      `[ratelimit] RATE_LIMITER='${mode}' but RATE_LIMITER_BINDING is missing — falling back to isolate limiter`
    );
    warnedMissingBinding = true;
  }

  if (mode === 'binding' && binding) {
    return getBindingLimiter(binding, false).middleware(c, next);
  }
  if (mode === 'binding-shadow' && binding) {
    await getBindingLimiter(binding, true).middleware(c, async () => undefined);
    return isolateLimiter.middleware(c, next);
  }
  return isolateLimiter.middleware(c, next);
}
