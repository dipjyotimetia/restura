import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { upgradeWebSocket } from 'hono/cloudflare-workers';
import { httpEcho } from './handlers/http';
import { graphqlEcho } from './handlers/graphql';
import { sseEcho } from './handlers/sse';
import { websocketEcho } from './handlers/websocket';

export type Env = {
  ENVIRONMENT?: string;
};

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({ origin: '*' }));

app.get('/ws', upgradeWebSocket(websocketEcho));
app.get('/sse', sseEcho);
app.all('/graphql', graphqlEcho);
app.all('*', httpEcho);

export default app;
