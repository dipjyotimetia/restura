import { executeGrpcProxy } from '@shared/protocol/grpc-proxy';
import {
  GrpcProxyRequestBodySchema,
  MAX_GRPC_PROXY_BODY_BYTES,
} from '@shared/protocol/grpc-schema';
import type { Fetcher } from '@shared/protocol/types';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { NodeHostnameGuard } from '../adapters';
import type { Env } from '../env';
import { allowPrivateIPs, isLocalDevBypass } from '../shared/env';
import { rejectRedirect } from '../shared/redirect';
import { parseJsonBody } from '../shared/validate-body';

/**
 * Streaming body cap for `/api/grpc` — `parseJsonBody`'s `maxBytes` only
 * pre-checks a declared Content-Length. Mount before the handler.
 */
export const grpcBodyLimit = bodyLimit({
  maxSize: MAX_GRPC_PROXY_BODY_BYTES,
  onError: (c) => c.json({ error: 'Request body too large' }, 413),
});

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
      // Never follow a redirect off the validated host.
      redirect: 'manual',
    };
    if (req.body !== undefined) init.body = req.body;
    const r = rejectRedirect(await fetch(req.url, init), 'gRPC');
    return {
      status: r.status,
      statusText: r.statusText,
      headers: r.headers,
      text: () => r.text(),
      // Expose the stream so the shared core can read it with a byte cap
      // instead of buffering a chunked body whole via text() (#933).
      body: r.body,
      contentLengthHeader: r.headers.get('content-length'),
    };
  };
}

export function createGrpcHandler(nodeHostnameGuard?: NodeHostnameGuard) {
  return async function grpcHandler(c: Context<{ Bindings: Env }>) {
    // Same gate as worker/index.ts auth — see proxy.ts for rationale.
    const isDev = isLocalDevBypass(c.env);

    const parsed = await parseJsonBody(c.req.raw, GrpcProxyRequestBodySchema, {
      maxBytes: MAX_GRPC_PROXY_BODY_BYTES,
    });
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
        // The browser went away (tab closed, request aborted): stop the upstream call.
        signal: c.req.raw.signal,
      }
    );

    if (!result.ok) {
      if (result.status === 499) {
        // Caller cancelled (nginx "Client Closed Request" — not a status Hono
        // types). The client is usually gone; this only settles the handler.
        return new Response(JSON.stringify(result.payload), {
          status: 499,
          headers: { 'content-type': 'application/json' },
        });
      }
      return c.json(
        result.payload as Record<string, unknown>,
        result.status as 400 | 413 | 502 | 504
      );
    }
    return c.json(result.response);
  };
}

export const grpc = createGrpcHandler();
