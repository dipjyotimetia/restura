import { readBoundedText } from './binary';
import { GrpcStatusCode, GrpcStatusCodeName } from './grpc-status';
import { type GrpcStatusDetail, statusDetailsFromConnectJson } from './grpc-status-details';
import { sanitizeRequestHeaders, sanitizeResponseHeaders } from './header-policy';
import { MAX_RESPONSE_SIZE } from './http-proxy';
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
}

const SERVICE_RE = /^[a-zA-Z][a-zA-Z0-9_.]*$/;
const METHOD_RE = /^[A-Za-z][a-zA-Z0-9]*$/;
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

function parseConnectError(body: string): {
  code: GrpcStatusCode;
  message: string;
  details?: GrpcStatusDetail[];
} {
  try {
    const error = JSON.parse(body);
    if (error.code && typeof error.code === 'string') {
      // Rich error model: Connect carries google.rpc.Status details as
      // `details: [{ type, value (base64), debug? }]` (#883).
      const details = statusDetailsFromConnectJson(error.details);
      return {
        code: CONNECT_CODE_TO_GRPC[error.code] ?? GrpcStatusCode.UNKNOWN,
        message: error.message || 'Unknown error',
        ...(details.length > 0 ? { details } : {}),
      };
    }
    return { code: GrpcStatusCode.UNKNOWN, message: error.message || body };
  } catch {
    return { code: GrpcStatusCode.UNKNOWN, message: body };
  }
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
  if (!spec.service || !SERVICE_RE.test(spec.service)) {
    return { ok: false, status: 400, payload: { error: 'Invalid service name format' } };
  }
  if (!spec.method || !METHOD_RE.test(spec.method)) {
    return { ok: false, status: 400, payload: { error: 'Invalid method name format' } };
  }

  const baseUrl = spec.url.endsWith('/') ? spec.url.slice(0, -1) : spec.url;
  const connectUrl = `${baseUrl}/${spec.service}/${spec.method}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Connect-Protocol-Version': '1',
    ...sanitizeRequestHeaders(spec.metadata),
  };

  const timeout = spec.timeout ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

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
      const info = parseConnectError(text);
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
  }
}
