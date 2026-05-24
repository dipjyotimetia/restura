/**
 * Cloudflare Worker entry. Composes the shared Hono app (`./app.ts`) with the
 * Cloudflare-specific adapters: `cloudflare:sockets` for upstream CONNECT
 * tunnelling and `WebSocketPair` for native WebSocket termination. The Node /
 * Docker entry is at `./node-entry.ts` and supplies different adapters built
 * on `node:net` / `node:tls` / `ws`.
 */
import { createApp } from './app';
import { httpsViaConnectProxy, httpViaProxy } from './shared/tcp-proxy';
import { websocketHandler } from './handlers/websocket';

export type { Env } from './env';

const app = createApp({
  tcpProxy: { httpsViaConnectProxy, httpViaProxy },
  websocketHandler,
});

export default app;
