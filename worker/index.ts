import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { grpc } from './handlers/grpc';
import { grpcReflection } from './handlers/grpc-reflection';
import { mcp } from './handlers/mcp';
import { proxy } from './handlers/proxy';
import { rateLimitMiddleware } from './middleware/rateLimiter';

export type Env = {
  ENVIRONMENT?: string;
  ALLOWED_ORIGIN?: string;
  WORKER_PROXY_TOKEN?: string;
  REQUIRE_CF_ACCESS?: string;
  /**
   * Explicit dev-bypass switch. MUST also have ENVIRONMENT=='development'.
   * Set only in .dev.vars; never in a deployed wrangler.jsonc.
   */
  DEV_BYPASS_AUTH?: string;
};

const app = new Hono<{ Bindings: Env }>();

function isDevelopment(env: Env): boolean {
  return env.ENVIRONMENT === 'development';
}

function isLocalDevBypass(env: Env): boolean {
  // Real Miniflare local dev sets globalThis.MINIFLARE. In any other context
  // (preview deploy, staging, prod) require an explicit DEV_BYPASS_AUTH=true
  // binding *and* ENVIRONMENT=='development'. A production deploy that
  // accidentally inherits either single value still triggers the normal auth
  // path.
  if (!isDevelopment(env)) return false;
  const inMiniflare =
    typeof (globalThis as { MINIFLARE?: unknown }).MINIFLARE !== 'undefined';
  return inMiniflare || env.DEV_BYPASS_AUTH === 'true';
}

function originAllowedByPattern(origin: string, pattern: string): boolean {
  if (!pattern.includes('*')) return origin === pattern;

  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^.]+');
  return new RegExp(`^${escaped}$`).test(origin);
}

function resolveCorsOrigin(origin: string | undefined, env: Env): string {
  if (!origin) return '';

  const configuredOrigins = (env.ALLOWED_ORIGIN ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const allowedOrigins =
    configuredOrigins.length > 0
      ? configuredOrigins
      : isLocalDevBypass(env)
        ? ['http://localhost:5173', 'http://127.0.0.1:5173']
        : ['https://restura.dev'];

  return allowedOrigins.some((allowed) => originAllowedByPattern(origin, allowed)) ? origin : '';
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

app.use(
  '/api/*',
  cors({
    origin: (origin, c) => resolveCorsOrigin(origin, c.env),
  })
);
app.use('/api/*', proxyAuthMiddleware);
app.use('/api/*', rateLimitMiddleware);

app.post('/api/proxy', proxy);
app.post('/api/grpc', grpc);
app.post('/api/grpc/reflection', grpcReflection);
app.post('/api/mcp', mcp);

export default app;
