import { validateURL } from './url-validation';
import { sanitizeRequestHeaders, sanitizeResponseHeaders } from './header-policy';
import { buildRequestBody } from './body-builder';
import type { Fetcher, RequestSpec, ExecuteResult } from './types';

export const MAX_RESPONSE_SIZE = 10 * 1024 * 1024;
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']);
const DEFAULT_TIMEOUT_MS = 30_000;

export interface ExecuteHttpProxyOptions {
  allowLocalhost: boolean;
}

export async function executeHttpProxy(
  spec: RequestSpec,
  fetcher: Fetcher,
  options: ExecuteHttpProxyOptions
): Promise<ExecuteResult> {
  const method = spec.method.toUpperCase();

  if (!ALLOWED_METHODS.has(method)) {
    return { ok: false, status: 400, payload: { error: `Method ${spec.method} is not allowed` } };
  }

  const validation = validateURL(spec.url, {
    allowPrivateIPs: false,
    allowLocalhost: options.allowLocalhost,
  });
  if (!validation.valid) {
    return { ok: false, status: 400, payload: { error: `Invalid URL: ${validation.error}` } };
  }

  const targetUrl = new URL(spec.url);
  if (spec.params) {
    for (const [k, v] of Object.entries(spec.params)) targetUrl.searchParams.append(k, v);
  }

  const headers = sanitizeRequestHeaders(spec.headers);
  const { body, contentType } = buildRequestBody({
    bodyType: spec.bodyType,
    data: spec.data,
    formData: spec.formData,
  });

  if (contentType && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = contentType;
  }

  const timeout = spec.timeout ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const finalBody = !['GET', 'HEAD'].includes(method) ? body : undefined;
    const response = await fetcher({
      url: targetUrl.toString(),
      method,
      headers,
      body: finalBody,
      signal: controller.signal,
    });

    if (response.contentLengthHeader && Number(response.contentLengthHeader) > MAX_RESPONSE_SIZE) {
      return {
        ok: false,
        status: 413,
        payload: { error: `Response too large (max ${MAX_RESPONSE_SIZE / 1024 / 1024}MB)` },
      };
    }

    const text = await response.text();
    if (text.length > MAX_RESPONSE_SIZE) {
      return {
        ok: false,
        status: 413,
        payload: { error: `Response too large (max ${MAX_RESPONSE_SIZE / 1024 / 1024}MB)` },
      };
    }

    return {
      ok: true,
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: sanitizeResponseHeaders(response.headers),
        body: text,
        size: text.length,
      },
    };
  } catch (err) {
    if (controller.signal.aborted) {
      return {
        ok: false,
        status: 504,
        payload: { error: `Request timeout after ${timeout}ms` },
      };
    }
    const message = err instanceof Error ? err.message : 'Proxy request failed';
    return { ok: false, status: 502, payload: { error: `Proxy request failed: ${message}` } };
  } finally {
    clearTimeout(timer);
  }
}
