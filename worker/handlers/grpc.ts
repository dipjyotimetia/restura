import type { Context } from 'hono';
import type { Env } from '../index';
import { executeGrpcProxy } from '@shared/protocol/grpc-proxy';
import type { Fetcher } from '@shared/protocol/types';

const fetcher: Fetcher = async (req) => {
  const init: RequestInit = {
    method: req.method,
    headers: req.headers,
    signal: req.signal,
  };
  if (req.body !== undefined) init.body = req.body;
  const r = await fetch(req.url, init);
  return {
    status: r.status,
    statusText: r.statusText,
    headers: r.headers,
    text: () => r.text(),
    contentLengthHeader: r.headers.get('content-length'),
  };
};

interface GrpcProxyRequestBody {
  url: string;
  service: string;
  method: string;
  metadata?: Record<string, string>;
  message?: unknown;
  timeout?: number;
}

export async function grpc(c: Context<{ Bindings: Env }>) {
  const isDev = c.env.ENVIRONMENT === 'development';

  let body: GrpcProxyRequestBody;
  try {
    body = await c.req.json<GrpcProxyRequestBody>();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return c.json(
      {
        grpcStatus: 13, // INTERNAL
        grpcStatusText: 'INTERNAL',
        headers: {},
        trailers: {},
        data: { error: `Proxy error: ${message}` },
        size: 0,
      },
      500
    );
  }

  const result = await executeGrpcProxy(body, fetcher, { allowLocalhost: isDev });

  if (!result.ok) {
    return c.json(result.payload as Record<string, unknown>, result.status as 400 | 413 | 502 | 504);
  }
  return c.json(result.response);
}
