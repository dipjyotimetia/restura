import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { proxy } from './handlers/proxy';
import { grpc } from './handlers/grpc';
import { grpcReflection } from './handlers/grpc-reflection';
import { mcp } from './handlers/mcp';
import { rateLimitMiddleware } from './middleware/rateLimiter';

export type Env = {
  ENVIRONMENT?: string;
  ALLOWED_ORIGIN?: string;
};

const app = new Hono<{ Bindings: Env }>();

function allowedOrigin(origin: string | undefined, configuredOrigin: string | undefined): string {
  if (!origin) return configuredOrigin ?? 'https://restura.pages.dev';

  try {
    const { hostname } = new URL(origin);
    if (hostname === 'restura.pages.dev' || hostname.endsWith('.restura.pages.dev')) {
      return origin;
    }
  } catch {
    // Fall through to the configured production origin.
  }

  return configuredOrigin ?? 'https://restura.pages.dev';
}

app.use(
  '/api/*',
  cors({
    origin: (origin, c) => {
      if (c.env.ENVIRONMENT !== 'production') return origin ?? '*';
      return allowedOrigin(origin, c.env.ALLOWED_ORIGIN);
    },
  }),
);
app.use('/api/*', rateLimitMiddleware);

app.post('/api/proxy', proxy);
app.post('/api/grpc', grpc);
app.post('/api/grpc/reflection', grpcReflection);
app.post('/api/mcp', mcp);

export default app;
