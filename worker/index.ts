import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { proxy } from './handlers/proxy';
import { grpc } from './handlers/grpc';
import { grpcReflection } from './handlers/grpc-reflection';
import { mcp } from './handlers/mcp';
import { rateLimitMiddleware } from './middleware/rateLimiter';

export type Env = {
  ENVIRONMENT?: string;
};

const app = new Hono<{ Bindings: Env }>();

app.use('/api/*', cors());
app.use('/api/*', rateLimitMiddleware);

app.post('/api/proxy', proxy);
app.post('/api/grpc', grpc);
app.post('/api/grpc/reflection', grpcReflection);
app.post('/api/mcp', mcp);

export default app;
