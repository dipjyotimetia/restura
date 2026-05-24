import type { Context } from 'hono';
import type { Env } from '../env';
import type { NodeHostnameGuard } from '../adapters';
import { executeGrpcProxy } from '@shared/protocol/grpc-proxy';
import type { Fetcher } from '@shared/protocol/types';
import { GrpcProxyRequestBodySchema } from '@shared/protocol/grpc-schema';
import { parseJsonBody } from '../shared/validate-body';
import { allowPrivateIPs, isLocalDevBypass } from '../shared/env';

function buildFetcher(
  isDev: boolean,
  permitPrivateIPs: boolean,
  nodeHostnameGuard?: NodeHostnameGuard
): Fetcher {
  return async (req) => {
    if (nodeHostnameGuard) {
      await nodeHostnameGuard(new URL(req.url).hostname, {
        allowLocalhost: isDev,
        allowPrivateIPs: permitPrivateIPs,
      });
    }
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
}

export function createGrpcHandler(nodeHostnameGuard?: NodeHostnameGuard) {
  return async function grpcHandler(c: Context<{ Bindings: Env }>) {
    // Same gate as worker/index.ts auth — see proxy.ts for rationale.
    const isDev = isLocalDevBypass(c.env);

    const parsed = await parseJsonBody(c.req.raw, GrpcProxyRequestBodySchema);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }
    const body = parsed.value;
    const permitPrivateIPs = allowPrivateIPs(c.env);

    const result = await executeGrpcProxy(
      body,
      buildFetcher(isDev, permitPrivateIPs, nodeHostnameGuard),
      {
        allowLocalhost: isDev,
        allowPrivateIPs: permitPrivateIPs,
      }
    );

    if (!result.ok) {
      return c.json(
        result.payload as Record<string, unknown>,
        result.status as 400 | 413 | 502 | 504
      );
    }
    return c.json(result.response);
  };
}

export const grpc = createGrpcHandler();
