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

// `Env` lives in ./env — import it from there directly. The re-export that
// previously lived here has been removed since all handlers/middleware now
// import from the canonical source.

const app = createApp({
  tcpProxy: { httpsViaConnectProxy, httpViaProxy },
  websocketHandler,
});

export default app;
