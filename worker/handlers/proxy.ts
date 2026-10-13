import { checkHttpMethod } from '@shared/protocol/http-method';
import { executeHttpProxy, executeHttpProxyStreaming } from '@shared/protocol/http-proxy';
import {
  containsAuthHandle,
  type ProxyRequestBody,
  ProxyRequestBodySchema,
  type UpstreamProxyConfig,
} from '@shared/protocol/proxy-schema';
import type { Fetcher } from '@shared/protocol/types';
import { validateURL } from '@shared/protocol/url-validation';
import type { Context } from 'hono';
import { stream } from 'hono/streaming';
import type { StatusCode } from 'hono/utils/http-status';
import type { NodeHostnameGuard, TcpProxyAdapter } from '../adapters';
import type { Env } from '../env';
import { isLocalDevBypass, allowPrivateIPs as readAllowPrivateIPs } from '../shared/env';
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

/**
 * Cloudflare's workerd only sends methods from a fixed list (standard methods,
 * PURGE, WebDAV, QUERY, …) and its Request constructor throws
 * `TypeError: Invalid HTTP method string` for any other RFC 9110 token. Probe
 * the runtime the same way fetch() would, so the hosted web proxy answers with
 * a clear 400 instead of a generic 502. Node (self-host) accepts any token,
 * so this never fires there.
 *
 * workerd also upper-cases the registered methods it does accept
 * (`propFind` goes out as `PROPFIND`); returning the runtime's own form lets
 * the shared core sign (SigV4 / Digest) exactly what goes on the wire.
 *
 * Policy failures (non-token, CONNECT/TRACE/TRACK) pass through unchanged so
 * the shared core produces its own 400.
 */
function resolveRuntimeMethod(
  method: string
): { ok: true; method: string } | { ok: false; error: string } {
  const check = checkHttpMethod(method);
  if (!check.ok) return { ok: true, method };
  try {
    return {
      ok: true,
      method: new Request('https://method-probe.invalid/', { method: check.method }).method,
    };
  } catch {
    return {
      ok: false,
      error:
        `HTTP method ${check.method} cannot be sent by the hosted web proxy — the Cloudflare ` +
        'Workers runtime supports only a fixed method list. Use the Restura desktop app or a ' +
        'self-hosted server for this method.',
    };
  }
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
      arrayBuffer: () => response.arrayBuffer(),
      contentLengthHeader: response.headers.get('content-length'),
      body: response.body,
    };
  };
}

/**
 * Build a /api/proxy handler with the platform's TCP-proxy adapter injected.
 * The Cloudflare entry passes the `tcp-proxy` adapter (uses `cloudflare:sockets`);
 * the Node entry passes the `tcp-proxy-node` adapter (uses `node:net`/`node:tls`)
 * along with `nodeHostnameGuard`, a pre-flight SSRF DNS check that Workers don't need.
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

    // Desktop-only TLS knobs are inert on Cloudflare Workers (no per-request
    // control over the TLS handshake). Reject early so the renderer can
    // surface a clear "open in desktop app" message instead of silently
    // dropping the setting. Mirrors the existing pattern for client certs.
    if (
      body.serverCipherOrder !== undefined ||
      body.minTlsVersion !== undefined ||
      (body.cipherSuites !== undefined && body.cipherSuites !== '')
    ) {
      return c.json(
        {
          error:
            'TLS cipher / protocol controls are desktop-only — open this request in the Restura desktop app.',
        },
        400
      );
    }

    // Only the direct fetch() path is limited by the runtime; the upstream-proxy
    // path writes the request line itself over a raw socket.
    let method = body.method;
    if (!body.upstreamProxy) {
      const runtimeMethod = resolveRuntimeMethod(body.method);
      if (!runtimeMethod.ok) return c.json({ error: runtimeMethod.error }, 400);
      method = runtimeMethod.method;
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
          method,
          url: body.url,
          headers: body.headers,
          params: body.params,
          bodyType: body.bodyType,
          data: body.data,
          formData: body.formData,
          timeout: body.timeout,
          auth: body.auth,
          ...(body.redirectPolicy !== undefined && { redirectPolicy: body.redirectPolicy }),
          ...(body.encodeUrl !== undefined && { encodeUrl: body.encodeUrl }),
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
        method,
        url: body.url,
        headers: body.headers,
        params: body.params,
        bodyType: body.bodyType,
        data: body.data,
        formData: body.formData,
        timeout: body.timeout,
        auth: body.auth,
        ...(body.redirectPolicy !== undefined && { redirectPolicy: body.redirectPolicy }),
        ...(body.encodeUrl !== undefined && { encodeUrl: body.encodeUrl }),
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
      ...(result.response.bodyEncoding ? { bodyEncoding: result.response.bodyEncoding } : {}),
      ...(result.response.timings ? { timings: result.response.timings } : {}),
    });
  };
}
