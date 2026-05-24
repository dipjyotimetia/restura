/**
 * Worker environment bindings. Lives in its own module so other files
 * (handlers, middleware, adapters, the Node entry) can import without
 * pulling in the Cloudflare-specific `worker/index.ts`.
 */

export type Env = {
  ENVIRONMENT?: string;
  ALLOWED_ORIGIN?: string;
  WORKER_PROXY_TOKEN?: string;
  REQUIRE_CF_ACCESS?: string;
  /**
   * Explicit dev-bypass switch. MUST also have ENVIRONMENT=='development'.
   * Set only in .dev.vars / .env for self-hosted dev; never in production.
   */
  DEV_BYPASS_AUTH?: string;
  /**
   * Relax the SSRF guard to allow RFC 1918 / link-local / CGNAT upstreams.
   * For self-hosted enterprise deployments that need to reach internal
   * services. Off by default; carries DNS-rebind caveats (see SELF_HOSTING.md).
   */
  ALLOW_PRIVATE_IPS?: string;
  /**
   * Rate-limiter implementation switch:
   *   - 'binding'        — Cloudflare Rate Limiting binding (production).
   *   - 'binding-shadow' — call binding, log decisions, but enforce via legacy
   *                        isolate limiter (validation period during rollout).
   *   - 'map' or unset   — legacy per-isolate Map (also the Node default).
   */
  RATE_LIMITER?: 'binding' | 'binding-shadow' | 'map';
  RATE_LIMITER_BINDING?: { limit(input: { key: string }): Promise<{ success: boolean }> };
};
