import { validateURL } from './url-validation';
import { sanitizeRequestHeaders, sanitizeResponseHeaders } from './header-policy';
import { buildRequestBody } from './body-builder';
import { applyAuth } from './auth-signer';
import type { Fetcher, RequestSpec, ExecuteResult } from './types';

export const MAX_RESPONSE_SIZE = 10 * 1024 * 1024;
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']);
const DEFAULT_TIMEOUT_MS = 30_000;

function byteLength(s: string): number {
  return new Blob([s]).size;
}

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

    // Apply sign-at-wire auth (currently AWS SigV4) AFTER body construction
    // and BEFORE the fetcher — the signature must cover the exact bytes the
    // upstream receives, including the canonical URL with query params.
    if (spec.auth && spec.auth.type !== 'none') {
      try {
        const applied = await applyAuth(spec.auth, {
          method,
          url: targetUrl.toString(),
          headers,
          body: finalBody,
        });
        Object.assign(headers, applied.headers);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown';
        return {
          ok: false,
          status: 500,
          payload: { error: `Auth signing failed: ${message}` },
        };
      }
    }

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

    const normalized: ExecuteResult = {
      ok: true,
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: sanitizeResponseHeaders(response.headers),
        body: text,
        size: byteLength(text),
      },
    };
    if (normalized.ok && response.negotiatedAlpn) {
      normalized.response.negotiatedAlpn = response.negotiatedAlpn;
    }
    return normalized;
  } catch (err) {
    const isAbort =
      controller.signal.aborted ||
      (err instanceof Error && err.name === 'AbortError');
    if (isAbort) {
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

// ============================================================================
// Streaming variant
// ============================================================================

export interface StreamingResponseHandle {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** The upstream stream — caller is responsible for reading and closing it. */
  body: ReadableStream<Uint8Array>;
  negotiatedAlpn?: 'h1.1' | 'h2' | 'h3';
}

export type StreamingExecuteResult =
  | { ok: true; response: StreamingResponseHandle }
  | { ok: false; status: number; payload: { error: string } };

/**
 * Streaming variant of executeHttpProxy. Same validation, header sanitisation,
 * body construction, and timeout handling — but instead of buffering the upstream
 * response via text(), it hands the underlying ReadableStream to the caller.
 *
 * Differences from executeHttpProxy:
 * - Returns StreamingResponseHandle (with body: ReadableStream) instead of NormalizedResponse.
 * - Does NOT enforce MAX_RESPONSE_SIZE — streaming is unbounded by design;
 *   consumers (renderer viewer, worker pipe) apply their own per-chunk budgets.
 * - The fetcher MUST provide response.body. Returns 502 if it doesn't.
 *
 * The caller owns the stream lifecycle: read it to completion or call cancel()
 * to free upstream resources. The timeout protects only the headers/connect
 * phase; once the fetcher returns, the timer is cleared and the caller may
 * read indefinitely. Caller-driven cancellation is via body.cancel().
 */
export async function executeHttpProxyStreaming(
  spec: RequestSpec,
  fetcher: Fetcher,
  options: ExecuteHttpProxyOptions
): Promise<StreamingExecuteResult> {
  const method = spec.method.toUpperCase();

  if (!ALLOWED_METHODS.has(method)) {
    return {
      ok: false,
      status: 400,
      payload: { error: `Method ${spec.method} is not allowed` },
    };
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
  const { body: requestBody, contentType } = buildRequestBody({
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
    const finalBody = !['GET', 'HEAD'].includes(method) ? requestBody : undefined;

    // Apply sign-at-wire auth (currently AWS SigV4) AFTER body construction
    // and BEFORE the fetcher. See executeHttpProxy above for rationale.
    if (spec.auth && spec.auth.type !== 'none') {
      try {
        const applied = await applyAuth(spec.auth, {
          method,
          url: targetUrl.toString(),
          headers,
          body: finalBody,
        });
        Object.assign(headers, applied.headers);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown';
        return {
          ok: false,
          status: 500,
          payload: { error: `Auth signing failed: ${message}` },
        };
      }
    }

    const response = await fetcher({
      url: targetUrl.toString(),
      method,
      headers,
      body: finalBody,
      signal: controller.signal,
    });

    if (!response.body) {
      return {
        ok: false,
        status: 502,
        payload: { error: 'Upstream did not provide a streaming body' },
      };
    }

    const handle: StreamingResponseHandle = {
      status: response.status,
      statusText: response.statusText,
      headers: sanitizeResponseHeaders(response.headers),
      body: response.body,
    };
    if (response.negotiatedAlpn) {
      handle.negotiatedAlpn = response.negotiatedAlpn;
    }

    return { ok: true, response: handle };
  } catch (err) {
    const isAbort =
      controller.signal.aborted ||
      (err instanceof Error && err.name === 'AbortError');
    if (isAbort) {
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
