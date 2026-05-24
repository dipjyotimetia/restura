/**
 * Node / Docker entry — single-process server that hosts both the SPA static
 * files and the `/api/*` Hono app on one port. Wires the same `createApp`
 * factory the Cloudflare entry uses, but supplies Node-native adapters for
 * the two Cloudflare-only features (CONNECT proxy, native WebSocket).
 */
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import type { Env } from './env';
import { createHttpsViaConnectProxy, createHttpViaProxy } from './shared/tcp-proxy-node';
import { assertNodeHostnameSafe } from './shared/dns-guard-node';
import { createNodeWebsocketHandler } from './handlers/websocket-node';

// The Node bundle lives at `dist/server/index.mjs`; the SPA at `dist/web/`.
// Resolve relative to the bundle so the same Docker WORKDIR works for both.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = process.env.RESTURA_STATIC_ROOT ?? path.resolve(__dirname, '..', 'web');
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

const app = new Hono<{ Bindings: Env }>();

// `c.env` is auto-populated from Cloudflare bindings on Workers; in Node we
// have to inject it ourselves from process.env. MUST mutate (Object.assign)
// rather than reassign — @hono/node-ws stamps `incoming` and a symbol-keyed
// connection token onto the SAME env object reference it passed into
// app.fetch, and reads them back later when the upgrade fires. Replacing
// `c.env = {...}` orphans those, breaking every WebSocket upgrade.
app.use('*', async (c, next) => {
  const additions = {
    ENVIRONMENT: process.env.ENVIRONMENT,
    ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN,
    WORKER_PROXY_TOKEN: process.env.WORKER_PROXY_TOKEN,
    REQUIRE_CF_ACCESS: process.env.REQUIRE_CF_ACCESS,
    DEV_BYPASS_AUTH: process.env.DEV_BYPASS_AUTH,
    ALLOW_PRIVATE_IPS: process.env.ALLOW_PRIVATE_IPS,
    RATE_LIMITER: process.env.RATE_LIMITER as 'binding' | 'binding-shadow' | 'map' | undefined,
  };
  if (c.env) {
    Object.assign(c.env, additions);
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c as any).env = additions;
  }
  await next();
});

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// DNS-guard configuration is a process-level concern (operator sets it via
// .env), so snapshot it at startup and bake it into the adapter closures.
// Changing it requires a container restart, which is the expected behaviour.
const dnsGuardOpts = {
  allowLocalhost: process.env.ENVIRONMENT === 'development',
  allowPrivateIPs: process.env.ALLOW_PRIVATE_IPS === 'true',
};

// Refuse to start in misconfigured rate-limit modes: 'binding' / 'binding-
// shadow' both require the Cloudflare Rate-Limiting binding object, which
// Node cannot supply. Silently falling back to the isolate limiter (the
// previous behaviour) hides the misconfiguration permanently.
const rateLimiterMode = process.env.RATE_LIMITER;
if (rateLimiterMode === 'binding' || rateLimiterMode === 'binding-shadow') {
  console.error(
    `[restura] RATE_LIMITER='${rateLimiterMode}' is Cloudflare-only and has no Node equivalent. ` +
      `Use RATE_LIMITER=map (the Node default) or omit the variable.`
  );
  process.exit(1);
}

// Register all API + health routes on the same Hono instance so the WS
// upgrade hook (bound to `app` above) can intercept `/api/ws`.
createApp(
  {
    tcpProxy: {
      httpsViaConnectProxy: createHttpsViaConnectProxy(dnsGuardOpts),
      httpViaProxy: createHttpViaProxy(dnsGuardOpts),
    },
    // @hono/node-ws's upgradeWebSocket has slightly different generics across
    // versions; the runtime shape is a Hono middleware, which is what
    // createApp registers.
    websocketHandler: createNodeWebsocketHandler(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      upgradeWebSocket as any,
      dnsGuardOpts
    ),
    nodeHostnameGuard: assertNodeHostnameSafe,
  },
  app
);

// API not-found handler: scoped to /api/* so unknown API routes return JSON
// 404 instead of falling through to the SPA fallback below (which would
// answer with index.html, masking typos as 200 HTML to API clients).
app.all('/api/*', (c) => c.json({ error: 'Not Found' }, 404));

// SPA fallback. Mount AFTER createApp so `/api/*` and `/health` take priority.
app.use(
  '/*',
  serveStatic({
    root: path.relative(process.cwd(), STATIC_ROOT) || '.',
  })
);
// SPA hash-routing means unknown paths still need to serve index.html. The
// SPA renders the right route from the URL hash; the server just needs to
// hand the shell back.
app.get('*', async (c) => {
  try {
    const html = await fs.readFile(path.join(STATIC_ROOT, 'index.html'), 'utf-8');
    return c.html(html);
  } catch {
    return c.text('SPA bundle not found — did the build stage run?', 500);
  }
});

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`[restura] listening on http://${info.address}:${info.port}`);
  console.log(`[restura] static root: ${STATIC_ROOT}`);
});

injectWebSocket(server);

const shutdown = (signal: NodeJS.Signals): void => {
  console.log(`[restura] received ${signal}, draining connections`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
