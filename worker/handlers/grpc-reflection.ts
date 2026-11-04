import { executeGrpcReflectionProxy } from '@shared/protocol/grpc-reflection-proxy';
import {
  GrpcReflectionRequestBodySchema,
  MAX_GRPC_REFLECTION_BODY_BYTES,
} from '@shared/protocol/grpc-schema';
import type { Fetcher } from '@shared/protocol/types';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { type NodeGuardedFetch, upstreamFetch } from '../adapters';
import type { Env } from '../env';
import { allowPrivateIPs, isLocalDevBypass } from '../shared/env';
import { rejectRedirect } from '../shared/redirect';
import { parseJsonBody } from '../shared/validate-body';

/**
 * Fetch override for the reflection upstream hop (tests). Reflection is a
 * bidi-streaming RPC that Connect servers only accept over HTTP/2, so on Node
 * the injected `nodeFetch` is asked for h2 (undici `allowH2`); Workers use the
 * runtime fetch.
 */
export type ReflectionFetch = (input: string, init: RequestInit) => Promise<Response>;

function buildFetcher(
  fetchImpl: ReflectionFetch | undefined,
  isDev: boolean,
  permitPrivateIPs: boolean,
  nodeFetch?: NodeGuardedFetch
): Fetcher {
  // Node: the pinned fetch over HTTP/2. Otherwise an injected fetch (tests),
  // else the runtime global, resolved lazily so swapped globals are honoured.
  const doFetch: ReflectionFetch =
    fetchImpl ??
    ((input, init) =>
      upstreamFetch(nodeFetch, input, init, {
        allowLocalhost: isDev,
        allowPrivateIPs: permitPrivateIPs,
        http2: true,
      }));
  return async (req) => {
    const init: RequestInit = {
      method: req.method,
      headers: req.headers,
      signal: req.signal,
      // Never follow a redirect off the SSRF-validated host.
      redirect: 'manual',
    };
    if (req.body !== undefined) init.body = req.body;
    const r = rejectRedirect(await doFetch(req.url, init), 'gRPC reflection');
    return {
      status: r.status,
      statusText: r.statusText,
      headers: r.headers,
      text: () => r.text(),
      arrayBuffer: () => r.arrayBuffer(),
      body: r.body,
      contentLengthHeader: r.headers.get('content-length'),
    };
  };
}

/** Streaming body cap for `/api/grpc/reflection` (see `grpcBodyLimit`). */
export const grpcReflectionBodyLimit = bodyLimit({
  maxSize: MAX_GRPC_REFLECTION_BODY_BYTES,
  onError: (c) => c.json({ error: 'Request body too large' }, 413),
});

export function createGrpcReflectionHandler(
  nodeFetch?: NodeGuardedFetch,
  fetchImpl?: ReflectionFetch
) {
  return async function grpcReflectionHandler(c: Context<{ Bindings: Env }>) {
    const parsed = await parseJsonBody(c.req.raw, GrpcReflectionRequestBodySchema, {
      maxBytes: MAX_GRPC_REFLECTION_BODY_BYTES,
    });
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }

    // Same gate as worker/index.ts auth — see proxy.ts for rationale.
    const isDev = isLocalDevBypass(c.env);
    const permitPrivateIPs = allowPrivateIPs(c.env);

    const result = await executeGrpcReflectionProxy(
      parsed.value,
      buildFetcher(fetchImpl, isDev, permitPrivateIPs, nodeFetch),
      { allowLocalhost: isDev, allowPrivateIPs: permitPrivateIPs }
    );
    if (!result.ok) {
      return c.json(result.payload, result.status as 400 | 413 | 500);
    }
    return c.json(result.response);
  };
}

export const grpcReflection = createGrpcReflectionHandler();
