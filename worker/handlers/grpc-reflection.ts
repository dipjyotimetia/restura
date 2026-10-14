import { executeGrpcReflectionProxy } from '@shared/protocol/grpc-reflection-proxy';
import { GrpcReflectionRequestBodySchema } from '@shared/protocol/grpc-schema';
import type { Fetcher } from '@shared/protocol/types';
import type { Context } from 'hono';
import type { NodeHostnameGuard } from '../adapters';
import type { Env } from '../env';
import { allowPrivateIPs, isLocalDevBypass } from '../shared/env';
import { parseJsonBody } from '../shared/validate-body';

/**
 * Fetch used for the reflection upstream hop. Reflection is a bidi-streaming
 * RPC that Connect servers only accept over HTTP/2, so the Node entry injects
 * an h2-capable fetch (undici `allowH2`); Workers use the runtime fetch.
 */
export type ReflectionFetch = (input: string, init: RequestInit) => Promise<Response>;

function buildFetcher(
  fetchImpl: ReflectionFetch,
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
      // Never follow a redirect off the SSRF-validated host.
      redirect: 'manual',
    };
    if (req.body !== undefined) init.body = req.body;
    const r = await fetchImpl(req.url, init);
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

export function createGrpcReflectionHandler(
  nodeHostnameGuard?: NodeHostnameGuard,
  fetchImpl?: ReflectionFetch
) {
  return async function grpcReflectionHandler(c: Context<{ Bindings: Env }>) {
    const parsed = await parseJsonBody(c.req.raw, GrpcReflectionRequestBodySchema);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }

    // Same gate as worker/index.ts auth — see proxy.ts for rationale.
    const isDev = isLocalDevBypass(c.env);
    const permitPrivateIPs = allowPrivateIPs(c.env);
    // Resolve the global lazily so tests (and runtimes) that swap it are honoured.
    const doFetch: ReflectionFetch = fetchImpl ?? ((input, init) => fetch(input, init));

    const result = await executeGrpcReflectionProxy(
      parsed.value,
      buildFetcher(doFetch, isDev, permitPrivateIPs, nodeHostnameGuard),
      { allowLocalhost: isDev, allowPrivateIPs: permitPrivateIPs }
    );
    if (!result.ok) {
      return c.json(result.payload, result.status as 400 | 413 | 500);
    }
    return c.json(result.response);
  };
}

export const grpcReflection = createGrpcReflectionHandler();
