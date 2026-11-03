import { readBoundedText } from './binary';
import { isValidGrpcMethodName, isValidGrpcServiceName } from './grpc-names';
import { GrpcStatusCode, GrpcStatusCodeName, grpcStatusFromHttpStatus } from './grpc-status';
import { type GrpcStatusDetail, statusDetailsFromConnectJson } from './grpc-status-details';
import { sanitizeRequestHeaders, sanitizeResponseHeaders } from './header-policy';
import { MAX_RESPONSE_SIZE } from './http-proxy';
import { discardBody } from './redirect-follower';
import type { Fetcher } from './types';
import { validateURL } from './url-validation';

export interface GrpcSpec {
  url: string;
  service: string;
  method: string;
  metadata?: Record<string, string>;
  message?: unknown;
  timeout?: number;
}

export interface GrpcNormalizedResponse {
  grpcStatus: number;
  grpcStatusText: string;
  headers: Record<string, string>;
  trailers: Record<string, string>;
  data: unknown;
  size: number;
  /** Decoded google.rpc.Status details of an error (absent when none were sent). */
  statusDetails?: GrpcStatusDetail[];
}

export type GrpcExecuteResult =
  | { ok: true; response: GrpcNormalizedResponse }
  | {
      ok: false;
      status: number;
      payload: { error: string } | GrpcNormalizedResponse;
    };

export interface ExecuteGrpcOptions {
  allowLocalhost: boolean;
  /** Self-hosted opt-in for RFC 1918 / link-local / CGNAT targets. */
  allowPrivateIPs?: boolean;
  /**
   * Caller cancellation (client disconnect, CLI abort). Distinct from the
   * deadline: an abort through this signal ends as CANCELLED, not
   * DEADLINE_EXCEEDED.
   */
  signal?: AbortSignal;
}

/**
 * Connect-protocol headers the proxy owns. A user metadata entry with one of
 * these names would otherwise merge into ours (`content-type: application/json,
 * application/grpc`) or override the deadline the proxy enforces.
 */
const RESERVED_REQUEST_HEADERS = new Set([
  'content-type',
  'content-encoding',
  'accept-encoding',
  'connect-protocol-version',
  'connect-timeout-ms',
  'connect-content-encoding',
  'connect-accept-encoding',
]);

/** Longest slice of a non-Connect error body quoted in the error message. */
const MAX_ERROR_SNIPPET_CHARS = 200;

const DEFAULT_TIMEOUT_MS = 30_000;

const CONNECT_CODE_TO_GRPC: Record<string, GrpcStatusCode> = {
  canceled: GrpcStatusCode.CANCELLED,
  unknown: GrpcStatusCode.UNKNOWN,
  invalid_argument: GrpcStatusCode.INVALID_ARGUMENT,
  deadline_exceeded: GrpcStatusCode.DEADLINE_EXCEEDED,
  not_found: GrpcStatusCode.NOT_FOUND,
  already_exists: GrpcStatusCode.ALREADY_EXISTS,
  permission_denied: GrpcStatusCode.PERMISSION_DENIED,
  resource_exhausted: GrpcStatusCode.RESOURCE_EXHAUSTED,
  failed_precondition: GrpcStatusCode.FAILED_PRECONDITION,
  aborted: GrpcStatusCode.ABORTED,
  out_of_range: GrpcStatusCode.OUT_OF_RANGE,
  unimplemented: GrpcStatusCode.UNIMPLEMENTED,
  internal: GrpcStatusCode.INTERNAL,
  unavailable: GrpcStatusCode.UNAVAILABLE,
  data_loss: GrpcStatusCode.DATA_LOSS,
  unauthenticated: GrpcStatusCode.UNAUTHENTICATED,
};

function emptyGrpcResponse(code: GrpcStatusCode, error: string): GrpcNormalizedResponse {
  return {
    grpcStatus: code,
    grpcStatusText: GrpcStatusCodeName[code] ?? 'UNKNOWN',
    headers: {},
    trailers: {},
    data: { error },
    size: 0,
  };
}

/**
 * Status of a non-2xx Connect unary response. A Connect server answers with a
 * JSON error body `{ code, message, details }`; anything else (an HTML 404 from
 * a gateway, a native-gRPC-only server's 415, a load balancer's 503) carries no
 * gRPC status, so the code comes from the HTTP status (Connect spec "HTTP to
 * Error Code" mapping) and the message names the HTTP status rather than
 * dumping the page.
 */
export function parseConnectError(
  httpStatus: number,
  body: string,
  contentType: string | null | undefined
): {
  code: GrpcStatusCode;
  message: string;
  details?: GrpcStatusDetail[];
} {
  try {
    const error = JSON.parse(body);
    // Own-property lookup: an upstream `code` is untrusted (e.g. "constructor").
    const known =
      error && typeof error.code === 'string' && Object.hasOwn(CONNECT_CODE_TO_GRPC, error.code)
        ? (CONNECT_CODE_TO_GRPC[error.code] as GrpcStatusCode)
        : undefined;
    if (known !== undefined) {
      // Rich error model: Connect carries google.rpc.Status details as
      // `details: [{ type, value (base64), debug? }]` (#883).
      const details = statusDetailsFromConnectJson(error.details);
      return {
        code: known,
        message: typeof error.message === 'string' && error.message ? error.message : error.code,
        ...(details.length > 0 ? { details } : {}),
      };
    }
  } catch {
    // Not JSON — fall through to the HTTP-status mapping.
  }
  const code = grpcStatusFromHttpStatus(httpStatus);
  const isHtml = (contentType ?? '').toLowerCase().includes('html');
  const snippet = isHtml ? '' : body.trim().slice(0, MAX_ERROR_SNIPPET_CHARS);
  const hint =
    httpStatus === 415 || httpStatus === 404
      ? ' — the server may not speak the Connect protocol (native gRPC needs the desktop app, or pin gRPC-Web)'
      : '';
  return { code, message: `HTTP ${httpStatus}${snippet ? `: ${snippet}` : ''}${hint}` };
}

export async function executeGrpcProxy(
  spec: GrpcSpec,
  fetcher: Fetcher,
  options: ExecuteGrpcOptions
): Promise<GrpcExecuteResult> {
  const urlValidation = validateURL(spec.url, {
    allowPrivateIPs: options.allowPrivateIPs === true,
    allowLocalhost: options.allowLocalhost,
  });
  if (!urlValidation.valid) {
    return { ok: false, status: 400, payload: { error: `Invalid URL: ${urlValidation.error}` } };
  }
  if (!spec.service || !isValidGrpcServiceName(spec.service)) {
    return { ok: false, status: 400, payload: { error: 'Invalid service name format' } };
  }
  if (!spec.method || !isValidGrpcMethodName(spec.method)) {
    return { ok: false, status: 400, payload: { error: 'Invalid method name format' } };
  }

  // Build via URL (as grpc-web-proxy does) so a query/fragment in spec.url
  // can't swallow the path. Both are dropped: a Connect/gRPC-Web route is
  // `/<service>/<method>` and gRPC carries no query, so web/desktop agree.
  const target = new URL(spec.url);
  target.search = '';
  target.hash = '';
  target.pathname = `${target.pathname.replace(/\/+$/, '')}/${spec.service}/${spec.method}`;
  const connectUrl = target.toString();

  const timeout =
    typeof spec.timeout === 'number' && Number.isFinite(spec.timeout) && spec.timeout > 0
      ? spec.timeout
      : DEFAULT_TIMEOUT_MS;

  const userHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(sanitizeRequestHeaders(spec.metadata))) {
    if (!RESERVED_REQUEST_HEADERS.has(k.toLowerCase())) userHeaders[k] = v;
  }
  const headers: Record<string, string> = {
    ...userHeaders,
    'Content-Type': 'application/json',
    'Connect-Protocol-Version': '1',
    // Propagate the deadline so the server stops work we've stopped waiting for.
    'Connect-Timeout-Ms': String(Math.ceil(timeout)),
  };

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  const onCallerAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', onCallerAbort, { once: true });

  try {
    const response = await fetcher({
      url: connectUrl,
      method: 'POST',
      headers,
      body: JSON.stringify(spec.message ?? {}),
      signal: controller.signal,
    });

    const tooLargeMsg = `Response too large (max ${MAX_RESPONSE_SIZE / 1024 / 1024}MB)`;
    if (response.contentLengthHeader && Number(response.contentLengthHeader) > MAX_RESPONSE_SIZE) {
      await discardBody(response);
      return {
        ok: false,
        status: 413,
        payload: emptyGrpcResponse(GrpcStatusCode.RESOURCE_EXHAUSTED, tooLargeMsg),
      };
    }
    // Bounded read: a chunked upstream (no content-length) is cut off at the
    // cap instead of being buffered whole before the size check.
    const read = await readBoundedText(response, MAX_RESPONSE_SIZE);
    if (read === null) {
      return {
        ok: false,
        status: 413,
        payload: emptyGrpcResponse(GrpcStatusCode.RESOURCE_EXHAUSTED, tooLargeMsg),
      };
    }
    const text = read.text;

    const sanitized = sanitizeResponseHeaders(response.headers);
    const trailers: Record<string, string> = {};
    const headersOut: Record<string, string> = {};
    for (const [k, v] of Object.entries(sanitized)) {
      if (k.toLowerCase().startsWith('trailer-')) {
        trailers[k.slice(8).toLowerCase()] = v;
      } else {
        headersOut[k] = v;
      }
    }

    let grpcStatus: GrpcStatusCode = GrpcStatusCode.OK;
    let grpcStatusText = 'OK';
    let data: unknown = {};
    let statusDetails: GrpcStatusDetail[] | undefined;
    if (response.status < 200 || response.status >= 300) {
      const info = parseConnectError(
        response.status,
        text,
        response.headers instanceof Headers
          ? response.headers.get('content-type')
          : headerValue(response.headers, 'content-type')
      );
      grpcStatus = info.code;
      grpcStatusText = GrpcStatusCodeName[grpcStatus] ?? 'UNKNOWN';
      data = { error: info.message };
      statusDetails = info.details;
    } else {
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text };
      }
    }

    return {
      ok: true,
      response: {
        grpcStatus,
        grpcStatusText,
        headers: headersOut,
        trailers,
        data,
        size: read.bytes,
        ...(statusDetails ? { statusDetails } : {}),
      },
    };
  } catch (err) {
    const isAbort =
      controller.signal.aborted || (err instanceof Error && err.name === 'AbortError');
    if (isAbort && !timedOut && options.signal?.aborted === true) {
      return {
        ok: false,
        status: 499,
        payload: emptyGrpcResponse(GrpcStatusCode.CANCELLED, 'Call cancelled'),
      };
    }
    if (isAbort) {
      return {
        ok: false,
        status: 504,
        payload: emptyGrpcResponse(
          GrpcStatusCode.DEADLINE_EXCEEDED,
          `Request timeout after ${timeout}ms`
        ),
      };
    }
    const message = err instanceof Error ? err.message : 'Proxy request failed';
    return {
      ok: false,
      status: 502,
      payload: emptyGrpcResponse(GrpcStatusCode.UNAVAILABLE, `Proxy request failed: ${message}`),
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onCallerAbort);
  }
}

function headerValue(
  headers: Record<string, string | string[]> | undefined,
  name: string
): string | undefined {
  if (!headers) return undefined;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return Array.isArray(v) ? v.join(', ') : v;
  }
  return undefined;
}
