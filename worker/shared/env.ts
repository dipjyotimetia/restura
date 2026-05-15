import type { Env } from '../index';

/**
 * Strict development-bypass gate. ENVIRONMENT='development' alone is NOT
 * enough — must also be running under Miniflare (auto-detected) OR have an
 * explicit DEV_BYPASS_AUTH=true binding (set only in .dev.vars). A preview
 * or production deploy that accidentally inherits ENVIRONMENT=development
 * MUST still trigger the normal auth path AND the production-strict
 * SSRF guards (no allowLocalhost).
 *
 * Used by both the auth middleware (worker/index.ts) and every handler that
 * needs to relax SSRF checks for local development (worker/handlers/*.ts).
 * Centralised here so the security contract has one source of truth.
 */
export function isLocalDevBypass(env: Env): boolean {
  if (env.ENVIRONMENT !== 'development') return false;
  const inMiniflare =
    typeof (globalThis as { MINIFLARE?: unknown }).MINIFLARE !== 'undefined';
  return inMiniflare || env.DEV_BYPASS_AUTH === 'true';
}
