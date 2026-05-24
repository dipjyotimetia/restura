import type { Context } from 'hono';
import { stream } from 'hono/streaming';
import type { StatusCode } from 'hono/utils/http-status';
import type { Env } from '../env';
import type { NodeHostnameGuard, TcpProxyAdapter } from '../adapters';
import { executeHttpProxy, executeHttpProxyStreaming } from '@shared/protocol/http-proxy';
import { validateURL } from '@shared/protocol/url-validation';
import type { Fetcher } from '@shared/protocol/types';
import {
  ProxyRequestBodySchema,
  containsAuthHandle,
  type ProxyRequestBody,
  type UpstreamProxyConfig,
} from '@shared/protocol/proxy-schema';
import { allowPrivateIPs as readAllowPrivateIPs, isLocalDevBypass } from '../shared/env';
import { parseJsonBody } from '../shared/validate-body';

const STREAMING_MEDIA_TYPES = new Set([
  'text/event-stream',
  'application/x-ndjson',
  'application/jsonl',
  'application/grpc-web',
]);

/**
 * Token-parse the Accept header per RFC 7231 (media-type [;params][, ...])
 * and exact-match against the streaming allowlist. The previous
 * `accept.includes('text/event-stream')` check was vulnerable to
 * `Accept: text/event-stream-evil` smuggling — that matched the substring
 * and routed the request through the streaming pass-through, bypassing the
 * buffered-response size cap.
 */
function parseAcceptMediaTypes(accept: string): string[] {
  return accept
    .split(',')
    .map((entry) => entry.split(';')[0]!.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Decide whether to route through the streaming pass-through.
 *
 * `streamingMode: true` is an unconditional bypass for callers that need raw
 * byte streams (e.g. binary downloads). It is validated as a boolean by the
 * `ProxyRequestBodySchema` (Task 1.2), so a renderer cannot smuggle a
 * non-boolean value through this branch.
 */
function isStreamingRequest(body: ProxyRequestBody): boolean {
  if (body.streamingMode === true) return true;
  const accept = body.headers?.['Accept'] ?? body.headers?.['accept'] ?? '';
  return parseAcceptMediaTypes(accept).some((mt) => STREAMING_MEDIA_TYPES.has(mt));
}

function buildFetcher(
  isDev: boolean,
  upstream: UpstreamProxyConfig | undefined,
  tcpProxy: TcpProxyAdapter,
  allowPrivateIPs: boolean,
  nodeHostnameGuard?: NodeHostnameGuard
): Fetcher {
  return async (req) => {
    let response: Response;
    if (upstream) {
      // Reject hostnames with URL-injection characters before constructing the validation URL
      if (!/^[a-zA-Z0-9.\-[\]:]+$/.test(upstream.host)) {
        throw new Error('Invalid proxy host: contains illegal characters');
      }
      // Honour ALLOW_PRIVATE_IPS for the proxy-host check too — operators that
      // explicitly opt in to internal targets typically use an internal proxy.
      const proxyValidation = validateURL(`http://${upstream.host}:${upstream.port}`, {
        allowPrivateIPs,
        allowLocalhost: isDev,
      });
      if (!proxyValidation.valid) {
        throw new Error(`Invalid upstream proxy: ${proxyValidation.error}`);
      }
      const targetUrl = new URL(req.url);
      const init: RequestInit = {
        method: req.method,
        headers: req.headers,
        signal: req.signal,
        redirect: 'manual',
      };
      if (req.body !== undefined) init.body = req.body;
      response =
        targetUrl.protocol === 'https:'
          ? await tcpProxy.httpsViaConnectProxy(targetUrl, upstream, init, req.signal)
          : await tcpProxy.httpViaProxy(targetUrl, upstream, init, req.signal);
    } else {
      if (nodeHostnameGuard) {
        await nodeHostnameGuard(new URL(req.url).hostname, {
          allowLocalhost: isDev,
          allowPrivateIPs,
        });
      }
      const init: RequestInit = {
        method: req.method,
        headers: req.headers,
        signal: req.signal,
        redirect: 'manual',
      };
      if (req.body !== undefined) init.body = req.body;
      response = await fetch(req.url, init);
    }
    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      text: () => response.text(),
      contentLengthHeader: response.headers.get('content-length'),
      body: response.body,
    };
  };
}

/**
 * Build a /api/proxy handler with the supplied TCP-proxy adapter injected.
 * The Cloudflare entry passes `cloudflareTcpProxy` (uses `cloudflare:sockets`);
 * the Node entry passes `nodeTcpProxy` (uses `node:net`/`node:tls`).
 */
export function createProxyHandler(
  tcpProxy: TcpProxyAdapter,
  nodeHostnameGuard?: NodeHostnameGuard
) {
  return async function proxyHandler(c: Context<{ Bindings: Env }>) {
    // Use the same gate as auth (worker/app.ts). ENVIRONMENT='development'
    // alone MUST NOT relax allowLocalhost — a preview deploy that inherits
    // the env var would otherwise become an open SSRF to internal hosts.
    const isDev = isLocalDevBypass(c.env);

    const parsed = await parseJsonBody(c.req.raw, ProxyRequestBodySchema);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }
    const body: ProxyRequestBody = parsed.value;

    if (containsAuthHandle(body.auth)) {
      return c.json(
        {
          error: 'Secret handles are desktop-only — open this request in the Restura desktop app.',
        },
        400
      );
    }

    // Self-hosted enterprises with internal upstreams can opt into private-IP
    // access via ALLOW_PRIVATE_IPS=true. Distinct from `isDev` so that production
    // self-hosted deployments don't accidentally also relax other dev guards.
    const allowPrivateIPs = readAllowPrivateIPs(c.env);
    const fetcher = buildFetcher(
      isDev,
      body.upstreamProxy,
      tcpProxy,
      allowPrivateIPs,
      nodeHostnameGuard
    );

    if (isStreamingRequest(body)) {
      const streamingResult = await executeHttpProxyStreaming(
        {
          method: body.method,
          url: body.url,
          headers: body.headers,
          params: body.params,
          bodyType: body.bodyType,
          data: body.data,
          formData: body.formData,
          timeout: body.timeout,
          auth: body.auth,
        },
        fetcher,
        { allowLocalhost: isDev, allowPrivateIPs }
      );

      if (!streamingResult.ok) {
        return c.json(streamingResult.payload, streamingResult.status as 400 | 502 | 504);
      }

      // Forward sanitised upstream headers verbatim to the renderer.
      for (const [k, v] of Object.entries(streamingResult.response.headers)) {
        c.header(k, v);
      }
      // Forward the upstream status code (200 typical, but any 2xx/4xx/5xx is valid).
      c.status(streamingResult.response.status as StatusCode);

      // Pipe upstream body through Hono's streaming helper. Hono's stream() takes
      // care of stream lifecycle (close, abort propagation) for us.
      const upstreamBody = streamingResult.response.body;
      return stream(c, async (s) => {
        await s.pipe(upstreamBody);
      });
    }

    const result = await executeHttpProxy(
      {
        method: body.method,
        url: body.url,
        headers: body.headers,
        params: body.params,
        bodyType: body.bodyType,
        data: body.data,
        formData: body.formData,
        timeout: body.timeout,
        auth: body.auth,
      },
      fetcher,
      { allowLocalhost: isDev, allowPrivateIPs }
    );

    if (!result.ok) {
      return c.json(result.payload, result.status as 400 | 413 | 500 | 502 | 504);
    }
    // Preserve the worker's historical response shape: `data` instead of `body`.
    // Renderer (`requestExecutor.ts`) reads `proxyResponse.data`.
    return c.json({
      status: result.response.status,
      statusText: result.response.statusText,
      headers: result.response.headers,
      data: result.response.body,
      size: result.response.size,
    });
  };
}
