import { GrpcStatusCode, GrpcStatusCodeName } from './grpc-status';
import { validateURL } from './url-validation';
import { sanitizeRequestHeaders, sanitizeResponseHeaders } from './header-policy';
import type { Fetcher } from './types';
import { MAX_RESPONSE_SIZE } from './http-proxy';

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
}

const SERVICE_RE = /^[a-zA-Z][a-zA-Z0-9_.]*$/;
const METHOD_RE = /^[A-Za-z][a-zA-Z0-9]*$/;
const DEFAULT_TIMEOUT_MS = 30_000;

function parseConnectError(body: string): { code: number; message: string } {
  try {
    const error = JSON.parse(body);
    if (error.code && typeof error.code === 'string') {
      const map: Record<string, number> = {
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
      return {
        code: map[error.code] ?? GrpcStatusCode.UNKNOWN,
        message: error.message || 'Unknown error',
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
    allowPrivateIPs: false,
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

    if (response.contentLengthHeader && Number(response.contentLengthHeader) > MAX_RESPONSE_SIZE) {
      return { ok: false, status: 413, payload: { error: `Response too large (max ${MAX_RESPONSE_SIZE / 1024 / 1024}MB)` } };
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_SIZE) {
      return { ok: false, status: 413, payload: { error: `Response too large (max ${MAX_RESPONSE_SIZE / 1024 / 1024}MB)` } };
    }

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

    let grpcStatus: number = GrpcStatusCode.OK;
    let grpcStatusText = 'OK';
    let data: unknown = {};
    if (response.status < 200 || response.status >= 300) {
      const info = parseConnectError(text);
      grpcStatus = info.code;
      grpcStatusText = GrpcStatusCodeName[grpcStatus as GrpcStatusCode] ?? 'UNKNOWN';
      data = { error: info.message };
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
        size: text.length,
      },
    };
  } catch (err) {
    const isAbort =
      controller.signal.aborted ||
      (err instanceof Error && err.name === 'AbortError');
    if (isAbort) {
      return {
        ok: false,
        status: 504,
        payload: {
          grpcStatus: GrpcStatusCode.DEADLINE_EXCEEDED,
          grpcStatusText: 'DEADLINE_EXCEEDED',
          headers: {},
          trailers: {},
          data: { error: `Request timeout after ${timeout}ms` },
          size: 0,
        },
      };
    }
    const message = err instanceof Error ? err.message : 'Proxy request failed';
    return {
      ok: false,
      status: 502,
      payload: {
        grpcStatus: GrpcStatusCode.UNAVAILABLE,
        grpcStatusText: 'UNAVAILABLE',
        headers: {},
        trailers: {},
        data: { error: `Proxy request failed: ${message}` },
        size: 0,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
