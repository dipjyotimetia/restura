import type { Context } from 'hono';
import type { Env } from '../index';
import { executeGrpcProxy } from '@shared/protocol/grpc-proxy';
import type { Fetcher } from '@shared/protocol/types';
import { GrpcProxyRequestBodySchema } from '@shared/protocol/grpc-schema';
import { parseJsonBody } from '../shared/validate-body';
import { isLocalDevBypass } from '../shared/env';

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

export async function grpc(c: Context<{ Bindings: Env }>) {
  // Same gate as worker/index.ts auth — see proxy.ts for rationale.
  const isDev = isLocalDevBypass(c.env);

  const parsed = await parseJsonBody(c.req.raw, GrpcProxyRequestBodySchema);
  if (!parsed.ok) {
    return c.json({ error: parsed.error }, parsed.status);
  }
  const body = parsed.value;

  const result = await executeGrpcProxy(body, fetcher, {
    allowLocalhost: isDev,
    allowPrivateIPs: c.env.ALLOW_PRIVATE_IPS === 'true',
  });

  if (!result.ok) {
    return c.json(result.payload as Record<string, unknown>, result.status as 400 | 413 | 502 | 504);
  }
  return c.json(result.response);
}
