import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { proxy } from './handlers/proxy';
import { grpc } from './handlers/grpc';
import { grpcReflection } from './handlers/grpc-reflection';

export type Env = {
  ENVIRONMENT?: string;
};

const app = new Hono<{ Bindings: Env }>();

app.use('/api/*', cors());

app.post('/api/proxy', proxy);
app.post('/api/grpc', grpc);
app.post('/api/grpc/reflection', grpcReflection);

export default app;
