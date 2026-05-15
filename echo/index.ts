/**
 * Restura echo Worker — controlled upstream for cross-cutting integration tests.
 *
 * Hosts: HTTP, GraphQL, SSE, plain WebSocket, gRPC-Web/Connect.
 *
 * Does NOT host Socket.IO. Socket.IO has a stateful handshake / polling-to-
 * WebSocket upgrade lifecycle that depends on Node `http.Server` and per-client
 * server-side state — neither maps cleanly to Cloudflare Workers without
 * effectively re-implementing the Engine.IO adapter inside a Durable Object.
 * The Socket.IO e2e fixture lives in `e2e/mocks/socketioServer.ts` (Node) and
 * is wired into `e2e/fixtures/servers.ts` alongside the other mock servers.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { upgradeWebSocket } from 'hono/cloudflare-workers';
import { httpEcho } from './handlers/http';
import { graphqlEcho } from './handlers/graphql';
import { sseEcho } from './handlers/sse';
import { websocketEcho } from './handlers/websocket';
import { connectEcho } from './handlers/connect';
import { rateLimitMiddleware } from './middleware/rateLimiter';

export type Env = {
  ENVIRONMENT?: string;
};

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({ origin: '*' }));
app.use('*', rateLimitMiddleware);

app.get('/ws', upgradeWebSocket(websocketEcho));
app.get('/sse', sseEcho);
app.all('/graphql', graphqlEcho);
app.use('/*', async (c, next) => {
  const res = await connectEcho(c.req.raw);
  if (res !== null) return res;
  return next();
});
app.all('*', httpEcho);

export default app;
