import type { Context } from 'hono';
import type { Env } from '../index';
import { executeHttpProxy } from '@shared/protocol/http-proxy';
import { validateURL } from '@shared/protocol/url-validation';
import type { Fetcher } from '@shared/protocol/types';
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
}

interface FetcherState {
  abortObserved: boolean;
}

function buildFetcher(
  isDev: boolean,
  upstream: UpstreamProxyConfig | undefined,
  state: FetcherState
): Fetcher {
  return async (req) => {
    try {
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
      };
    } catch (err) {
      // Preserve worker's historical behaviour: any AbortError surfaces as a timeout (504),
      // even when the upstream rejects with AbortError without first aborting the signal
      // (e.g. mocked `fetch` in tests). The shared core only checks `signal.aborted`.
      if (err instanceof Error && err.name === 'AbortError') {
        state.abortObserved = true;
      }
      throw err;
    }
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

  const fetcherState: FetcherState = { abortObserved: false };
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
    },
    buildFetcher(isDev, body.upstreamProxy, fetcherState),
    { allowLocalhost: isDev }
  );

  if (!result.ok) {
    // Map upstream AbortError → 504 to preserve historical behaviour.
    if (fetcherState.abortObserved && result.status === 502) {
      const timeout = body.timeout ?? 30000;
      return c.json({ error: `Request timeout after ${timeout}ms` }, 504);
    }
    return c.json(result.payload, result.status as 400 | 413 | 502 | 504);
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
