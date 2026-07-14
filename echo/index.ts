/**
 * Restura echo Worker — controlled upstream for cross-cutting integration tests.
 *
 * Hosts: HTTP, GraphQL, SSE, plain WebSocket, gRPC-Web/Connect, and OpenAI/
 * Anthropic-shaped AI chat endpoints (`/v1/chat/completions`, `/v1/messages`).
 *
 * Does NOT host Socket.IO. Socket.IO has a stateful handshake / polling-to-
 * WebSocket upgrade lifecycle that depends on Node `http.Server` and per-client
 * server-side state — neither maps cleanly to Cloudflare Workers without
 * effectively re-implementing the Engine.IO adapter inside a Durable Object.
 * The Socket.IO e2e fixture lives in `e2e/mocks/socketioServer.ts` (Node) and
 * is wired into `e2e/fixtures/servers.ts` alongside the other mock servers.
 */
import { Hono } from 'hono';
import { upgradeWebSocket } from 'hono/cloudflare-workers';
import { cors } from 'hono/cors';
import { handleAnthropicChat, handleOpenAiChat } from './handlers/ai';
import { connectEcho } from './handlers/connect';
import { graphqlEcho } from './handlers/graphql';
import { httpEcho } from './handlers/http';
import { sseEcho } from './handlers/sse';
import { websocketEcho } from './handlers/websocket';
import { rateLimitMiddleware } from './middleware/rateLimiter';

export type EchoEnv = {
  ENVIRONMENT?: string;
};

const app = new Hono<{ Bindings: EchoEnv }>();

app.use('*', cors({ origin: '*' }));
app.use('*', rateLimitMiddleware);

app.get('/ws', upgradeWebSocket(websocketEcho));
app.get('/sse', sseEcho);
app.all('/graphql', graphqlEcho);
app.post('/v1/chat/completions', handleOpenAiChat);
app.post('/v1/messages', handleAnthropicChat);

app.use('/*', async (c, next) => {
  const res = await connectEcho(c.req.raw);
  if (res !== null) return res;
  return next();
});
app.all('*', httpEcho);

export default app;
