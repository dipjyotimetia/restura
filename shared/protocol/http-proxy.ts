import {
  applyAuth,
  inlineOnlySecretResolver,
  type SecretResolver,
  type SigV4Signer,
} from './auth-signer';
import {
  bytesToBase64,
  getHeaderCI,
  isBinaryContentType,
  readBoundedText,
  readStreamToBytes,
} from './binary';
import { type BuildRequestBodyArgs, buildRequestBody } from './body-builder';
import { type DigestRetryOptions, followRedirectsWithDigest } from './digest-auth';
import {
  extractSetCookies,
  sanitizeRequestHeaders,
  sanitizeResponseHeaders,
} from './header-policy';
import { checkHttpMethod } from './http-method';
import { MAX_RESPONSE_SIZE } from './proxy-limits';
import { discardBody, RedirectPolicyError } from './redirect-follower';
import { appendQueryPairs, mergeAuthHeaders } from './request-spec';
import { type CookieHop, RedirectCookieChain } from './set-cookie';
import type {
  ConnectionTimings,
  ExecuteResult,
  Fetcher,
  RequestSpec,
  ResponseTimings,
} from './types';
import { validateURL } from './url-validation';

export { MAX_RESPONSE_SIZE, PROXY_STREAM_MARKER_HEADER } from './proxy-limits';

const DEFAULT_TIMEOUT_MS = 30_000;

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
  const params = spec.params ? Object.entries(spec.params) : [];
  if (spec.encodeUrl === false) {
    // The query goes before any `#fragment` (appendQueryPairs handles that).
    return appendQueryPairs(spec.url, params, { encode: false });
  }
  // The query the URL already carries (the renderer and CLI fold the user's
  // ordered, repeatable query rows into `spec.url`) keeps its bytes: WHATWG
  // parsing only escapes what is invalid in a query (space → `%20`), leaving
  // `+`, `:`, `,`, `/` and `%XX` as typed. `searchParams` is never touched — it
  // would re-serialize the whole query as form data (space → `+`, `:` → `%3A`).
  //
  // `spec.params` carries values nobody typed into the query: auth-added
  // credentials (API key in query) and Electron-main materialized secrets. Those
  // are opaque data, so they are escaped completely (space → `%20`, `+` → `%2B`).
  const u = new URL(spec.url);
  if (params.length > 0) {
    const tail = params
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const existing = u.search.length > 1 ? u.search.slice(1) : '';
    u.search = existing ? `${existing}&${tail}` : tail;
  }
  return u.toString();
}

/**
 * The URL the SSRF guard sees: everything before the query. The host and scheme
 * the guard binds on end before the first `?`/`#` in every WHATWG parse, and
 * the query — which used to travel in `spec.params`, outside the guard's
 * length cap — is now folded into `spec.url` by the renderer and CLI.
 */
function urlForValidation(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

/** Headers auth added, for the redirect follower. Authorization has its own `followAuthHeader` rule. */
function namesToStrip(applied: Record<string, string>): string[] {
  return Object.keys(applied).filter((name) => name.toLowerCase() !== 'authorization');
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

/**
 * Digest (RFC 7616) is challenge/response: nothing is added to the first
 * request; `followRedirectsWithDigest` answers a same-origin 401 Digest
 * challenge with exactly one retry. The password is resolved here — in the
 * process that sends the request (Electron main for desktop handles) — and
 * only its hash goes on the wire.
 */
function digestRetryFor(
  spec: RequestSpec,
  options: ExecuteHttpProxyOptions
): DigestRetryOptions | undefined {
  if (spec.auth?.type !== 'digest' || !spec.auth.digest) return undefined;
  const resolve = options.resolveSecret ?? inlineOnlySecretResolver;
  return {
    credentials: {
      username: spec.auth.digest.username,
      password: resolve(spec.auth.digest.password),
    },
    rebuildBody: () => buildRequestBody(bodyArgs(spec)).body,
  };
}

/** The spec's body fields, present ones only (clean under exactOptionalPropertyTypes). */
function bodyArgs(spec: RequestSpec): BuildRequestBodyArgs {
  return {
    ...(spec.bodyType !== undefined ? { bodyType: spec.bodyType } : {}),
    ...(spec.data !== undefined ? { data: spec.data } : {}),
    ...(spec.formData !== undefined ? { formData: spec.formData } : {}),
  };
}

const BODY_HEADER_NAMES = new Set(['content-type', 'content-length', 'content-encoding']);

/**
 * Sanitized headers and the body that goes on the wire.
 *
 * - A user's body is sent whatever the method, GET included (Postman
 *   behaviour). `fetch()`-backed hosts (Worker, self-host Node) refuse a GET
 *   body; that surfaces as an explicit 400 (see `bodyRefusedError`), never as a
 *   silently stripped body. HEAD alone drops the body — its response can carry
 *   none — and then also the headers that would describe it.
 * - A form-data body's multipart Content-Type is the runtime's to write: only
 *   it knows the boundary. A hand-set `multipart/form-data` (no boundary, or a
 *   boundary that will not match) is removed so every backend sets its own.
 */
function prepareRequest(
  spec: RequestSpec,
  method: string
): { headers: Record<string, string>; body: BodyInit | undefined } {
  const headers = sanitizeRequestHeaders(spec.headers);
  const { body, contentType } = buildRequestBody(bodyArgs(spec));

  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === 'content-type' && /^\s*multipart\/form-data\b/i.test(value)) {
        delete headers[name];
      }
    }
  }

  // A GET with an empty body editor (a body type picked, nothing typed) sends no
  // body: fetch() hosts would otherwise refuse a request nobody meant to carry one.
  const dropped = method === 'HEAD' || (method === 'GET' && isEmptyBody(body));
  if (dropped) {
    if (body !== undefined && method === 'HEAD') {
      for (const name of Object.keys(headers)) {
        if (BODY_HEADER_NAMES.has(name.toLowerCase())) delete headers[name];
      }
    }
    return { headers, body: undefined };
  }

  if (contentType && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = contentType;
  }
  return { headers, body };
}

function isEmptyBody(body: BodyInit | undefined): boolean {
  if (body === undefined || body === '') return true;
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    return body.keys().next().done === true;
  }
  return body instanceof Uint8Array && body.byteLength === 0;
}

/**
 * A `fetch()`-based host (Worker, self-host Node) throws a TypeError for a GET
 * with a body. Name the limit instead of reporting an opaque 502.
 */
function bodyRefusedError(err: unknown, method: string, hasBody: boolean): string | null {
  if (!hasBody || method !== 'GET' || !(err instanceof TypeError)) return null;
  if (!/GET|HEAD/.test(err.message) || !/body/i.test(err.message)) return null;
  return (
    'This proxy cannot send a request body with GET: it uses fetch(), which forbids it. ' +
    'Remove the body, use another method, or send it from the Restura desktop app or CLI.'
  );
}

export async function executeHttpProxy(
  spec: RequestSpec,
  fetcher: Fetcher,
  options: ExecuteHttpProxyOptions
): Promise<ExecuteResult> {
  const methodCheck = checkHttpMethod(spec.method);
  if (!methodCheck.ok) {
    return { ok: false, status: 400, payload: { error: methodCheck.error } };
  }
  const method = methodCheck.method;

  const validation = validateURL(urlForValidation(spec.url), {
    allowPrivateIPs: options.allowPrivateIPs === true,
    allowLocalhost: options.allowLocalhost,
  });
  if (!validation.valid) {
    return { ok: false, status: 400, payload: { error: `Invalid URL: ${validation.error}` } };
  }

  const wireUrl = buildTargetUrl(spec);

  const { headers, body } = prepareRequest(spec, method);

  const timeout = spec.timeout ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = timeout > 0 ? setTimeout(() => controller.abort(), timeout) : null;

  try {
    const finalBody = body;

    // Apply sign-at-wire auth (currently AWS SigV4) AFTER body construction
    // and BEFORE the fetcher — the signature must cover the exact bytes the
    // upstream receives, including the canonical URL with query params.
    let digest: DigestRetryOptions | undefined;
    let authAppliedHeaders: string[] = [];
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
        mergeAuthHeaders(headers, applied.headers);
        authAppliedHeaders = namesToStrip(applied.headers);
        digest = digestRetryFor(spec, options);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown';
        return {
          ok: false,
          status: 500,
          payload: { error: `Auth signing failed: ${message}` },
        };
      }
    }

    const startedAt = performance.now();
    const cookieChain = new RedirectCookieChain();
    const response = await followRedirectsWithDigest(
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
        stripOnOriginChange: [
          ...(spec.redirectPolicy?.stripOnOriginChange ?? []),
          ...authAppliedHeaders,
        ],
        cookieChain,
      },
      digest
    );

    const headersAt = performance.now();
    if (response.contentLengthHeader && Number(response.contentLengthHeader) > MAX_RESPONSE_SIZE) {
      await discardBody(response);
      return {
        ok: false,
        status: 413,
        payload: { error: `Response too large (max ${MAX_RESPONSE_SIZE / 1024 / 1024}MB)` },
      };
    }

    const responseHeaders = sanitizeResponseHeaders(response.headers);
    const setCookies = extractSetCookies(response.headers);

    // Binary content types are base64-encoded so the raw bytes survive the
    // JSON transport to the renderer (text() would UTF-8-decode and corrupt
    // them). Both branches read the body stream under the byte cap when the
    // fetcher surfaces one — a body without Content-Length (chunked, or a
    // decompressed upstream) must 413 at the cap, not buffer whole first —
    // and fall back to the buffered arrayBuffer()/text() only when it doesn't.
    // Stream and buffered reads share the body, so only one read happens.
    const responseContentType = getHeaderCI(responseHeaders, 'content-type');
    const binary = isBinaryContentType(responseContentType);
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
      if (response.body) {
        const bytes = await readStreamToBytes(response.body, MAX_RESPONSE_SIZE);
        if (bytes === null) return tooLarge;
        binaryBytes = bytes;
      } else if (response.arrayBuffer) {
        const buf = await response.arrayBuffer();
        if (buf.byteLength > MAX_RESPONSE_SIZE) return tooLarge;
        binaryBytes = new Uint8Array(buf);
      }
    }

    if (binaryBytes) {
      responseBody = bytesToBase64(binaryBytes);
      responseSize = binaryBytes.length;
      bodyEncoding = 'base64';
    } else {
      // Text content type, or a binary type the fetcher couldn't read as bytes.
      const bounded = await readBoundedText(response, MAX_RESPONSE_SIZE, responseContentType);
      if (bounded === null) return tooLarge;
      responseBody = bounded.text;
      responseSize = bounded.bytes;
    }

    const normalized: ExecuteResult = {
      ok: true,
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        ...(setCookies.length > 0 ? { setCookies } : {}),
        ...redirectCookieFields(cookieChain),
        body: responseBody,
        size: responseSize,
        ...(bodyEncoding ? { bodyEncoding } : {}),
      },
    };
    if (normalized.ok && response.negotiatedAlpn) {
      normalized.response.negotiatedAlpn = response.negotiatedAlpn;
    }
    if (normalized.ok && response.bodyNotice) {
      normalized.response.bodyNotice = response.bodyNotice;
    }
    if (normalized.ok) {
      normalized.response.timings = buildTimings(
        startedAt,
        headersAt,
        performance.now(),
        response.connectionTimings
      );
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
    const bodyRefused = bodyRefusedError(err, method, body !== undefined);
    if (bodyRefused) return { ok: false, status: 400, payload: { error: bodyRefused } };
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
  /** Every `Set-Cookie` field, one entry each (see NormalizedResponse.setCookies). */
  setCookies?: string[];
  /** See NormalizedResponse.finalUrl. */
  finalUrl?: string;
  /** See NormalizedResponse.cookieHops. */
  cookieHops?: CookieHop[];
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
 * read indefinitely. Caller-driven cancellation is via body.cancel(), or via
 * `options.signal`: it is chained into the request's controller for the whole
 * lifetime of the stream (connect, headers AND body reads), so aborting it
 * tears down the upstream request even after this function has returned.
 */
export async function executeHttpProxyStreaming(
  spec: RequestSpec,
  fetcher: Fetcher,
  options: ExecuteHttpProxyOptions
): Promise<StreamingExecuteResult> {
  const methodCheck = checkHttpMethod(spec.method);
  if (!methodCheck.ok) {
    return { ok: false, status: 400, payload: { error: methodCheck.error } };
  }
  const method = methodCheck.method;

  const validation = validateURL(urlForValidation(spec.url), {
    allowPrivateIPs: options.allowPrivateIPs === true,
    allowLocalhost: options.allowLocalhost,
  });
  if (!validation.valid) {
    return { ok: false, status: 400, payload: { error: `Invalid URL: ${validation.error}` } };
  }

  const wireUrl = buildTargetUrl(spec);

  const { headers, body: requestBody } = prepareRequest(spec, method);

  const timeout = spec.timeout ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  // Caller cancellation (the Worker passes the client request's signal). Unlike the buffered
  // variant the listener stays attached on success — the stream outlives this
  // call and must still be abortable; it's `once` and dropped with the signal.
  const abortFromCaller = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const detachCaller = () => options.signal?.removeEventListener('abort', abortFromCaller);
  const timer = timeout > 0 ? setTimeout(() => controller.abort(), timeout) : null;

  try {
    const finalBody = requestBody;

    // Apply sign-at-wire auth (currently AWS SigV4) AFTER body construction
    // and BEFORE the fetcher. See executeHttpProxy above for rationale.
    let digest: DigestRetryOptions | undefined;
    let authAppliedHeaders: string[] = [];
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
        mergeAuthHeaders(headers, applied.headers);
        authAppliedHeaders = namesToStrip(applied.headers);
        digest = digestRetryFor(spec, options);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown';
        detachCaller();
        return {
          ok: false,
          status: 500,
          payload: { error: `Auth signing failed: ${message}` },
        };
      }
    }

    const cookieChain = new RedirectCookieChain();
    const response = await followRedirectsWithDigest(
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
        stripOnOriginChange: [
          ...(spec.redirectPolicy?.stripOnOriginChange ?? []),
          ...authAppliedHeaders,
        ],
        cookieChain,
      },
      digest
    );

    if (!response.body) {
      detachCaller();
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
    const streamSetCookies = extractSetCookies(response.headers);
    if (streamSetCookies.length > 0) handle.setCookies = streamSetCookies;
    Object.assign(handle, redirectCookieFields(cookieChain));
    if (response.negotiatedAlpn) {
      handle.negotiatedAlpn = response.negotiatedAlpn;
    }

    return { ok: true, response: handle };
  } catch (err) {
    detachCaller();
    if (err instanceof RedirectPolicyError) {
      return { ok: false, status: 400, payload: { error: err.message } };
    }
    if (options.signal?.aborted) {
      return { ok: false, status: 499, payload: { error: 'Request aborted' } };
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
    const bodyRefused = bodyRefusedError(err, method, requestBody !== undefined);
    if (bodyRefused) return { ok: false, status: 400, payload: { error: bodyRefused } };
    const message = err instanceof Error ? err.message : 'Proxy request failed';
    return { ok: false, status: 502, payload: { error: `Proxy request failed: ${message}` } };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * `finalUrl` and `cookieHops` once a redirect was followed, so a jar stores each
 * response's cookies against the URL that set them. Nothing when the first
 * response was final (its cookies belong to the requested URL).
 */
function redirectCookieFields(chain: RedirectCookieChain): {
  finalUrl?: string;
  cookieHops?: CookieHop[];
} {
  if (chain.lastUrl === undefined || chain.responses < 2) return {};
  return {
    finalUrl: cookieScopeUrl(chain.lastUrl),
    ...(chain.hops.length > 0
      ? { cookieHops: chain.hops.map((h) => ({ ...h, url: cookieScopeUrl(h.url) })) }
      : {}),
  };
}

/**
 * The part of a wire URL a cookie jar needs (RFC 6265 scope: scheme, host,
 * port, path): `origin + pathname`. The wire URL can hold secrets the host
 * materialized (Electron main substitutes secret variables and API-key-in-query
 * handles into the query), and these fields travel back to the renderer
 * (ADR-0007) — so the query, fragment and userinfo never go with them.
 */
function cookieScopeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '';
  }
}

/** Round a timing breakdown to whole milliseconds; connection phases are kept when known. */
export function buildTimings(
  startedAt: number,
  headersAt: number,
  bodyDoneAt: number,
  connection?: ConnectionTimings
): ResponseTimings {
  const ms = (n: number) => Math.max(0, Math.round(n));
  return {
    ...(connection?.dns !== undefined ? { dns: ms(connection.dns) } : {}),
    ...(connection?.connect !== undefined ? { connect: ms(connection.connect) } : {}),
    ttfb: ms(headersAt - startedAt),
    download: ms(bodyDoneAt - headersAt),
  };
}
