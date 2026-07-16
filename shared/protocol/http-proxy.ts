import { applyAuth, type SecretResolver, type SigV4Signer } from './auth-signer';
import { bytesToBase64, getHeaderCI, isBinaryContentType, readStreamToBytes } from './binary';
import { buildRequestBody } from './body-builder';
import { sanitizeRequestHeaders, sanitizeResponseHeaders } from './header-policy';
import { followRedirects, RedirectPolicyError } from './redirect-follower';
import type { ExecuteResult, Fetcher, RequestSpec } from './types';
import { validateURL } from './url-validation';

export const MAX_RESPONSE_SIZE = 10 * 1024 * 1024;
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']);
const DEFAULT_TIMEOUT_MS = 30_000;

function byteLength(s: string): number {
  return new Blob([s]).size;
}

/**
 * Builds the URL that will go on the wire. When `spec.encodeUrl` is true (or
 * absent — current default behaviour), the URL goes through `new URL()` + the
 * `searchParams.append` path which percent-encodes both path and query. When
 * false, emit `spec.url` raw plus any params concatenated without encoding.
 *
 * SSRF/host/scheme validation is unaffected — `validateURL(spec.url)` runs
 * before this and parses through the WHATWG URL constructor regardless of
 * this flag, so host smuggling is still caught. Only path/query bytes can
 * legitimately differ between validator-view and wire-view.
 */
function buildTargetUrl(spec: RequestSpec): string {
  if (spec.encodeUrl === false) {
    const params = spec.params;
    if (!params || Object.keys(params).length === 0) return spec.url;
    const joiner = spec.url.includes('?') ? '&' : '?';
    const tail = Object.entries(params)
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    return `${spec.url}${joiner}${tail}`;
  }
  const u = new URL(spec.url);
  if (spec.params) {
    for (const [k, v] of Object.entries(spec.params)) u.searchParams.append(k, v);
  }
  return u.toString();
}

export interface ExecuteHttpProxyOptions {
  allowLocalhost: boolean;
  /** Optional caller cancellation, composed with the per-request timeout. */
  signal?: AbortSignal;
  /**
   * Allow targeting RFC 1918 / link-local / CGNAT addresses. Off by default;
   * self-hosted enterprise deployments may opt in via `ALLOW_PRIVATE_IPS=true`.
   * Threaded through to `followRedirects` so the whole chain is consistent.
   */
  allowPrivateIPs?: boolean;
  /** Resolves SecretValue fields in `spec.auth`. Electron passes a keychain-backed resolver; Worker defaults to inline-only (throws on handles). */
  resolveSecret?: SecretResolver;
  /** Overrides AWS SigV4 signing. Electron passes an `@smithy/signature-v4`-backed signer; the Worker omits it (built-in Web-Crypto signer). */
  sigV4Signer?: SigV4Signer;
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
    allowPrivateIPs: options.allowPrivateIPs === true,
    allowLocalhost: options.allowLocalhost,
  });
  if (!validation.valid) {
    return { ok: false, status: 400, payload: { error: `Invalid URL: ${validation.error}` } };
  }

  const wireUrl = buildTargetUrl(spec);

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
  const abortFromCaller = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = timeout > 0 ? setTimeout(() => controller.abort(), timeout) : null;

  try {
    const finalBody = !['GET', 'HEAD'].includes(method) ? body : undefined;

    // Apply sign-at-wire auth (currently AWS SigV4) AFTER body construction
    // and BEFORE the fetcher — the signature must cover the exact bytes the
    // upstream receives, including the canonical URL with query params.
    if (spec.auth && spec.auth.type !== 'none') {
      try {
        const applied = await applyAuth(spec.auth, {
          method,
          url: wireUrl,
          headers,
          body: finalBody,
          ...(options.resolveSecret ? { resolveSecret: options.resolveSecret } : {}),
          ...(options.sigV4Signer ? { sigV4Signer: options.sigV4Signer } : {}),
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

    const response = await followRedirects(
      {
        url: wireUrl,
        method,
        headers,
        body: finalBody,
        signal: controller.signal,
      },
      fetcher,
      {
        allowLocalhost: options.allowLocalhost,
        allowPrivateIPs: options.allowPrivateIPs === true,
        ...(spec.redirectPolicy?.followOriginalMethod !== undefined && {
          followOriginalMethod: spec.redirectPolicy.followOriginalMethod,
        }),
        ...(spec.redirectPolicy?.followAuthHeader !== undefined && {
          followAuthHeader: spec.redirectPolicy.followAuthHeader,
        }),
        ...(spec.redirectPolicy?.stripReferer !== undefined && {
          stripReferer: spec.redirectPolicy.stripReferer,
        }),
        ...(spec.redirectPolicy?.maxRedirects !== undefined && {
          maxRedirects: spec.redirectPolicy.maxRedirects,
        }),
      }
    );

    if (response.contentLengthHeader && Number(response.contentLengthHeader) > MAX_RESPONSE_SIZE) {
      return {
        ok: false,
        status: 413,
        payload: { error: `Response too large (max ${MAX_RESPONSE_SIZE / 1024 / 1024}MB)` },
      };
    }

    const responseHeaders = sanitizeResponseHeaders(response.headers);

    // Binary content types are base64-encoded so the raw bytes survive the
    // JSON transport to the renderer (text() would UTF-8-decode and corrupt
    // them). Read the bytes via arrayBuffer() when the fetcher exposes it (the
    // reliable read across workerd / Miniflare / undici), else the raw stream;
    // both share the body, so only one read happens.
    const binary = isBinaryContentType(getHeaderCI(responseHeaders, 'content-type'));
    const tooLarge = {
      ok: false as const,
      status: 413 as const,
      payload: { error: `Response too large (max ${MAX_RESPONSE_SIZE / 1024 / 1024}MB)` },
    };

    let responseBody: string;
    let responseSize: number;
    let bodyEncoding: 'base64' | undefined;

    let binaryBytes: Uint8Array | null = null;
    if (binary) {
      if (response.arrayBuffer) {
        const buf = await response.arrayBuffer();
        if (buf.byteLength > MAX_RESPONSE_SIZE) return tooLarge;
        binaryBytes = new Uint8Array(buf);
      } else if (response.body) {
        const bytes = await readStreamToBytes(response.body, MAX_RESPONSE_SIZE);
        if (bytes === null) return tooLarge;
        binaryBytes = bytes;
      }
    }

    if (binaryBytes) {
      responseBody = bytesToBase64(binaryBytes);
      responseSize = binaryBytes.length;
      bodyEncoding = 'base64';
    } else {
      // Text content type, or a binary type the fetcher couldn't read as bytes.
      const text = await response.text();
      if (text.length > MAX_RESPONSE_SIZE) return tooLarge;
      responseBody = text;
      responseSize = byteLength(text);
    }

    const normalized: ExecuteResult = {
      ok: true,
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body: responseBody,
        size: responseSize,
        ...(bodyEncoding ? { bodyEncoding } : {}),
      },
    };
    if (normalized.ok && response.negotiatedAlpn) {
      normalized.response.negotiatedAlpn = response.negotiatedAlpn;
    }
    return normalized;
  } catch (err) {
    if (err instanceof RedirectPolicyError) {
      return { ok: false, status: 400, payload: { error: err.message } };
    }
    const isAbort =
      controller.signal.aborted || (err instanceof Error && err.name === 'AbortError');
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
    if (timer !== null) clearTimeout(timer);
    options.signal?.removeEventListener('abort', abortFromCaller);
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
    allowPrivateIPs: options.allowPrivateIPs === true,
    allowLocalhost: options.allowLocalhost,
  });
  if (!validation.valid) {
    return { ok: false, status: 400, payload: { error: `Invalid URL: ${validation.error}` } };
  }

  const wireUrl = buildTargetUrl(spec);

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
  const timer = timeout > 0 ? setTimeout(() => controller.abort(), timeout) : null;

  try {
    const finalBody = !['GET', 'HEAD'].includes(method) ? requestBody : undefined;

    // Apply sign-at-wire auth (currently AWS SigV4) AFTER body construction
    // and BEFORE the fetcher. See executeHttpProxy above for rationale.
    if (spec.auth && spec.auth.type !== 'none') {
      try {
        const applied = await applyAuth(spec.auth, {
          method,
          url: wireUrl,
          headers,
          body: finalBody,
          ...(options.resolveSecret ? { resolveSecret: options.resolveSecret } : {}),
          ...(options.sigV4Signer ? { sigV4Signer: options.sigV4Signer } : {}),
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

    const response = await followRedirects(
      {
        url: wireUrl,
        method,
        headers,
        body: finalBody,
        signal: controller.signal,
      },
      fetcher,
      {
        allowLocalhost: options.allowLocalhost,
        allowPrivateIPs: options.allowPrivateIPs === true,
        ...(spec.redirectPolicy?.followOriginalMethod !== undefined && {
          followOriginalMethod: spec.redirectPolicy.followOriginalMethod,
        }),
        ...(spec.redirectPolicy?.followAuthHeader !== undefined && {
          followAuthHeader: spec.redirectPolicy.followAuthHeader,
        }),
        ...(spec.redirectPolicy?.stripReferer !== undefined && {
          stripReferer: spec.redirectPolicy.stripReferer,
        }),
        ...(spec.redirectPolicy?.maxRedirects !== undefined && {
          maxRedirects: spec.redirectPolicy.maxRedirects,
        }),
      }
    );

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
    if (err instanceof RedirectPolicyError) {
      return { ok: false, status: 400, payload: { error: err.message } };
    }
    const isAbort =
      controller.signal.aborted || (err instanceof Error && err.name === 'AbortError');
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
    if (timer !== null) clearTimeout(timer);
  }
}
