/**
 * Backend-agnostic Hono app factory. The Cloudflare entry (`worker/index.ts`)
 * and the Node/self-hosted entry (`worker/node-entry.ts`) both build their
 * app via this function, supplying the two impl-specific bits — upstream
 * TCP proxy (CONNECT) and native WebSocket termination — as injected
 * adapters. Everything else (CORS, auth, rate limiting, gRPC, MCP, feature
 * flags, telemetry, ws-ticket) is pure fetch / pure logic and reused.
 */
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppDeps } from './adapters';
import type { Env } from './env';
import { createProxyHandler } from './handlers/proxy';
import { createGrpcHandler } from './handlers/grpc';
import { createGrpcReflectionHandler } from './handlers/grpc-reflection';
import { createMcpHandler } from './handlers/mcp';
import { featureFlags } from './handlers/feature-flags';
import { telemetryError } from './handlers/telemetry';
import { wsTicket } from './handlers/ws-ticket';
import { rateLimitMiddleware } from './middleware/rateLimiter';
import { requestIdMiddleware } from './middleware/requestId';
import { isLocalDevBypass } from './shared/env';

// Build-time substituted by:
//   - Vite (Cloudflare bundle): see `define` in vite.config.mts
//   - esbuild (Node bundle):    see `--define:__APP_VERSION__=...` in
//                                package.json scripts.build:server
// Falls back to 'unknown' for type-check / test contexts where neither
// substitution ran.
declare const __APP_VERSION__: string | undefined;
const VERSION = (() => {
  try {
    return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown';
  } catch {
    return 'unknown';
  }
})();

function originAllowedByPattern(origin: string, pattern: string): boolean {
  if (!pattern.includes('*')) return origin === pattern;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^.]+');
  return new RegExp(`^${escaped}$`).test(origin);
}

/**
 * Resolve the CORS origin reply. Closed-by-default:
 *   1. If `ALLOWED_ORIGIN` is set (comma-separated, supports `*` wildcards),
 *      match the request Origin against the list.
 *   2. Local-dev bypass: allow vite + localhost only.
 *   3. Otherwise (production with no ALLOWED_ORIGIN): return ''. The previous
 *      "echo the request Origin" fallback effectively granted CORS to every
 *      site on the internet, which is a security downgrade. Operators MUST
 *      set ALLOWED_ORIGIN explicitly. The first request from a missing-
 *      ALLOWED_ORIGIN production deploy gets logged once for visibility.
 */
let warnedMissingAllowedOrigin = false;

function resolveCorsOrigin(origin: string | undefined, env: Env): string {
  if (!origin) return '';

  const configuredOrigins = (env.ALLOWED_ORIGIN ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (configuredOrigins.length > 0) {
    return configuredOrigins.some((allowed) => originAllowedByPattern(origin, allowed))
      ? origin
      : '';
  }

  if (isLocalDevBypass(env)) {
    const devOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173'];
    return devOrigins.includes(origin) ? origin : '';
  }

  if (!warnedMissingAllowedOrigin) {
    warnedMissingAllowedOrigin = true;
    // eslint-disable-next-line no-console
    console.warn(
      '[restura] ALLOWED_ORIGIN is not set and ENVIRONMENT is not "development" — ' +
        'all cross-origin requests will be denied by CORS. Set ALLOWED_ORIGIN ' +
        'in your env (comma-separated; supports `*` wildcards) to permit the SPA.'
    );
  }
  return '';
}

function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  const length = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;

  for (let i = 0; i < length; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }

  return diff === 0;
}

async function proxyAuthMiddleware(
  c: Context<{ Bindings: Env }>,
  next: Next
): Promise<Response | void> {
  if (c.req.method === 'OPTIONS' || isLocalDevBypass(c.env)) {
    return next();
  }

  const configuredToken = c.env.WORKER_PROXY_TOKEN;
  if (configuredToken) {
    const providedToken =
      c.req.header('X-Restura-Proxy-Token') ??
      c.req.header('Authorization')?.replace(/^Bearer\s+/i, '');
    if (providedToken && timingSafeEqual(providedToken, configuredToken)) {
      return next();
    }
    return c.json({ error: 'Unauthorized' }, 401);
  }

  if (c.env.REQUIRE_CF_ACCESS === 'true') {
    if (c.req.header('Cf-Access-Authenticated-User-Email')) {
      return next();
    }
    return c.json({ error: 'Cloudflare Access authentication required' }, 401);
  }

  return c.json({ error: 'Worker proxy authentication is not configured' }, 503);
}

/**
 * Register the Restura API + health endpoints on a Hono app. Accepts an
 * existing instance so the Node entry can pass the same app that
 * `@hono/node-ws#createNodeWebSocket` is bound to (the WS upgrade handler
 * must be registered on that exact instance).
 */
export function createApp(
  deps: AppDeps,
  baseApp?: Hono<{ Bindings: Env }>
): Hono<{ Bindings: Env }> {
  const app = baseApp ?? new Hono<{ Bindings: Env }>();

  // Health / readiness probes — outside /api/* so they bypass auth, CORS,
  // and rate-limit. Cheap and side-effect-free; safe for K8s liveness probes.
  app.get('/health', (c) => c.json({ status: 'ok', version: VERSION }));
  app.get('/ready', (c) => c.json({ status: 'ready', version: VERSION }));

  app.use(
    '/api/*',
    cors({
      origin: (origin, c) => resolveCorsOrigin(origin, c.env),
    })
  );
  app.use('/api/*', requestIdMiddleware);
  app.use('/api/*', proxyAuthMiddleware);
  app.use('/api/*', rateLimitMiddleware);

  app.post('/api/proxy', createProxyHandler(deps.tcpProxy, deps.nodeHostnameGuard));
  app.post('/api/grpc', createGrpcHandler(deps.nodeHostnameGuard));
  app.post('/api/grpc/reflection', createGrpcReflectionHandler(deps.nodeHostnameGuard));
  app.post('/api/mcp', createMcpHandler(deps.nodeHostnameGuard));
  app.post('/api/telemetry/error', telemetryError);
  app.get('/api/feature-flags', featureFlags);
  app.post('/api/ws-ticket', wsTicket);
  app.get('/api/ws', deps.websocketHandler);

  return app;
}
