import type { Context } from 'hono';
import { stream } from 'hono/streaming';
import type { StatusCode } from 'hono/utils/http-status';
import type { Env } from '../index';
import { executeHttpProxy, executeHttpProxyStreaming } from '@shared/protocol/http-proxy';
import { validateURL } from '@shared/protocol/url-validation';
import type { Fetcher, ProtocolAuthConfig } from '@shared/protocol/types';
import type { FormField, BodyType } from '@shared/protocol/body-builder';
import { httpsViaConnectProxy, httpViaProxy } from '../shared/tcp-proxy';

interface UpstreamProxyConfig {
  host: string;
  port: number;
  auth?: { username: string; password: string };
}

interface ProxyRequestBody {
  method: string;
  url: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  bodyType?: BodyType;
  data?: string;
  formData?: FormField[];
  timeout?: number;
  upstreamProxy?: UpstreamProxyConfig;
  /**
   * Sign-at-wire auth (currently AWS SigV4). Forwarded to executeHttpProxy so
   * the signature covers the exact bytes this worker sends to the upstream.
   * Renderer-side `applyAuthHeaders` no longer signs SigV4 — it passes the
   * auth config through to us instead.
   */
  auth?: ProtocolAuthConfig;
  /**
   * Forces the streaming pass-through path even when the Accept header doesn't
   * advertise a known streaming content type. Useful for raw byte streams.
   */
  streamingMode?: boolean;
}

const STREAMING_ACCEPT_TYPES = [
  'text/event-stream',
  'application/x-ndjson',
  'application/jsonl',
  'application/grpc-web',
];

function isStreamingRequest(body: ProxyRequestBody): boolean {
  if (body.streamingMode === true) return true;
  const accept =
    body.headers?.['Accept'] ?? body.headers?.['accept'] ?? '';
  const lower = accept.toLowerCase();
  return STREAMING_ACCEPT_TYPES.some((t) => lower.includes(t));
}

function buildFetcher(
  isDev: boolean,
  upstream: UpstreamProxyConfig | undefined
): Fetcher {
  return async (req) => {
    let response: Response;
    if (upstream) {
      // Reject hostnames with URL-injection characters before constructing the validation URL
      if (!/^[a-zA-Z0-9.\-[\]:]+$/.test(upstream.host)) {
        throw new Error('Invalid proxy host: contains illegal characters');
      }
      const proxyValidation = validateURL(`http://${upstream.host}:${upstream.port}`, {
        allowPrivateIPs: false,
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
        redirect: 'follow',
      };
      if (req.body !== undefined) init.body = req.body;
      response =
        targetUrl.protocol === 'https:'
          ? await httpsViaConnectProxy(targetUrl, upstream, init, req.signal)
          : await httpViaProxy(targetUrl, upstream, init, req.signal);
    } else {
      const init: RequestInit = {
        method: req.method,
        headers: req.headers,
        signal: req.signal,
        redirect: 'follow',
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

export async function proxy(c: Context<{ Bindings: Env }>) {
  const isDev = c.env.ENVIRONMENT === 'development';

  let body: ProxyRequestBody;
  try {
    body = await c.req.json<ProxyRequestBody>();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: `Proxy error: ${message}` }, 500);
  }

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
      buildFetcher(isDev, body.upstreamProxy),
      { allowLocalhost: isDev }
    );

    if (!streamingResult.ok) {
      return c.json(
        streamingResult.payload,
        streamingResult.status as 400 | 502 | 504
      );
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
    buildFetcher(isDev, body.upstreamProxy),
    { allowLocalhost: isDev }
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
}
