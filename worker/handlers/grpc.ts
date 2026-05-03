import { Context } from 'hono';
import { GrpcStatusCode, GrpcStatusCodeName } from '../shared/grpc-status';
import { validateURL } from '../shared/url-validation';
import { MAX_RESPONSE_SIZE } from '../shared/constants';

const BLOCKED_REQUEST_HEADERS = [
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'upgrade',
];

const BLOCKED_RESPONSE_HEADERS = [
  'transfer-encoding',
  'connection',
  'keep-alive',
];

interface GrpcProxyRequestBody {
  url: string;
  service: string;
  method: string;
  metadata?: Record<string, string>;
  message?: unknown;
  timeout?: number;
}

interface GrpcProxyResponse {
  grpcStatus: number;
  grpcStatusText: string;
  headers: Record<string, string>;
  trailers: Record<string, string>;
  data: unknown;
  size: number;
}

function validateServiceName(service: string): { valid: boolean; error?: string } {
  if (!service) return { valid: false, error: 'Service name is required' };
  if (!/^[a-zA-Z][a-zA-Z0-9_.]*$/.test(service)) {
    return { valid: false, error: 'Invalid service name format' };
  }
  return { valid: true };
}

function validateMethodName(method: string): { valid: boolean; error?: string } {
  if (!method) return { valid: false, error: 'Method name is required' };
  if (!/^[A-Za-z][a-zA-Z0-9]*$/.test(method)) {
    return { valid: false, error: 'Invalid method name format' };
  }
  return { valid: true };
}

function parseConnectError(body: string): { code: number; message: string } {
  try {
    const error = JSON.parse(body);
    if (error.code && typeof error.code === 'string') {
      const codeMap: Record<string, number> = {
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
        code: codeMap[error.code] ?? GrpcStatusCode.UNKNOWN,
        message: error.message || 'Unknown error',
      };
    }
    return { code: GrpcStatusCode.UNKNOWN, message: error.message || body };
  } catch {
    return { code: GrpcStatusCode.UNKNOWN, message: body };
  }
}

export async function grpc(c: Context) {
  try {
    const body = await c.req.json<GrpcProxyRequestBody>();
    const { url, service, method, metadata = {}, message = {}, timeout = 30000 } = body;

    const urlValidation = validateURL(url);
    if (!urlValidation.valid) {
      return c.json({ error: `Invalid URL: ${urlValidation.error}` }, 400);
    }

    const serviceValidation = validateServiceName(service);
    if (!serviceValidation.valid) {
      return c.json({ error: `Invalid service: ${serviceValidation.error}` }, 400);
    }

    const methodValidation = validateMethodName(method);
    if (!methodValidation.valid) {
      return c.json({ error: `Invalid method: ${methodValidation.error}` }, 400);
    }

    const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url;
    const connectUrl = `${baseUrl}/${service}/${method}`;

    const proxyHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
    };

    Object.entries(metadata).forEach(([key, value]) => {
      if (!BLOCKED_REQUEST_HEADERS.includes(key.toLowerCase())) {
        proxyHeaders[key] = value;
      }
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(connectUrl, {
        method: 'POST',
        headers: proxyHeaders,
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
        return c.json({ error: `Response too large (max ${MAX_RESPONSE_SIZE / 1024 / 1024}MB)` }, 413);
      }

      const responseBody = await response.text();

      if (responseBody.length > MAX_RESPONSE_SIZE) {
        return c.json({ error: `Response too large (max ${MAX_RESPONSE_SIZE / 1024 / 1024}MB)` }, 413);
      }

      const responseHeaders: Record<string, string> = {};
      const trailers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        const lowerKey = key.toLowerCase();
        if (lowerKey.startsWith('trailer-')) {
          trailers[lowerKey.slice(8)] = value;
        } else if (!BLOCKED_RESPONSE_HEADERS.includes(lowerKey)) {
          responseHeaders[key] = value;
        }
      });

      let grpcStatus: number = GrpcStatusCode.OK;
      let grpcStatusText = 'OK';
      let data: unknown = {};

      if (!response.ok) {
        const errorInfo = parseConnectError(responseBody);
        grpcStatus = errorInfo.code;
        grpcStatusText = GrpcStatusCodeName[grpcStatus as GrpcStatusCode] || 'UNKNOWN';
        data = { error: errorInfo.message };
      } else {
        try {
          data = responseBody ? JSON.parse(responseBody) : {};
        } catch {
          data = { raw: responseBody };
        }
      }

      const proxyResponse: GrpcProxyResponse = {
        grpcStatus,
        grpcStatusText,
        headers: responseHeaders,
        trailers,
        data,
        size: responseBody.length,
      };

      return c.json(proxyResponse);
    } catch (fetchError: unknown) {
      clearTimeout(timeoutId);

      if (fetchError instanceof Error) {
        if (fetchError.name === 'AbortError') {
          return c.json({
            grpcStatus: GrpcStatusCode.DEADLINE_EXCEEDED,
            grpcStatusText: 'DEADLINE_EXCEEDED',
            headers: {},
            trailers: {},
            data: { error: `Request timeout after ${timeout}ms` },
            size: 0,
          }, 504);
        }
        return c.json({
          grpcStatus: GrpcStatusCode.UNAVAILABLE,
          grpcStatusText: 'UNAVAILABLE',
          headers: {},
          trailers: {},
          data: { error: `Proxy request failed: ${fetchError.message}` },
          size: 0,
        }, 502);
      }

      return c.json({
        grpcStatus: GrpcStatusCode.UNKNOWN,
        grpcStatusText: 'UNKNOWN',
        headers: {},
        trailers: {},
        data: { error: 'Proxy request failed' },
        size: 0,
      }, 502);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({
      grpcStatus: GrpcStatusCode.INTERNAL,
      grpcStatusText: 'INTERNAL',
      headers: {},
      trailers: {},
      data: { error: `Proxy error: ${message}` },
      size: 0,
    }, 500);
  }
}
