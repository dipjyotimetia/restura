import { Router, Request, Response } from 'express';

export const grpcRouter = Router();

// gRPC Status codes
const GrpcStatusCode = {
  OK: 0,
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  ABORTED: 10,
  OUT_OF_RANGE: 11,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  DATA_LOSS: 15,
  UNAUTHENTICATED: 16,
} as const;

const GrpcStatusCodeName: Record<number, string> = {
  0: 'OK',
  1: 'CANCELLED',
  2: 'UNKNOWN',
  3: 'INVALID_ARGUMENT',
  4: 'DEADLINE_EXCEEDED',
  5: 'NOT_FOUND',
  6: 'ALREADY_EXISTS',
  7: 'PERMISSION_DENIED',
  8: 'RESOURCE_EXHAUSTED',
  9: 'FAILED_PRECONDITION',
  10: 'ABORTED',
  11: 'OUT_OF_RANGE',
  12: 'UNIMPLEMENTED',
  13: 'INTERNAL',
  14: 'UNAVAILABLE',
  15: 'DATA_LOSS',
  16: 'UNAUTHENTICATED',
};

// Maximum response body size (10MB)
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024;

// Headers that should not be forwarded
const BLOCKED_REQUEST_HEADERS = [
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'upgrade',
];

// Headers that should not be forwarded back
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

// Check if hostname is a private/local address (SSRF protection)
function isPrivateAddress(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return true;
  }

  const ipv4Pattern = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const match = hostname.match(ipv4Pattern);
  if (match) {
    const [, a, b] = match.map(Number);
    if (a === 10) return true;
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
  }

  if (hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80')) {
    return true;
  }

  return false;
}

// Validate gRPC URL format
function validateGrpcUrl(url: string): { valid: boolean; error?: string } {
  if (!url) {
    return { valid: false, error: 'URL is required' };
  }

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return { valid: false, error: 'URL must start with http:// or https://' };
  }

  try {
    const parsed = new URL(url);

    if (isPrivateAddress(parsed.hostname)) {
      return { valid: false, error: 'Access to private/local addresses is not allowed' };
    }

    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
}

// Validate service name format
function validateServiceName(service: string): { valid: boolean; error?: string } {
  if (!service) {
    return { valid: false, error: 'Service name is required' };
  }

  const servicePattern = /^[a-zA-Z][a-zA-Z0-9_.]*$/;
  if (!servicePattern.test(service)) {
    return { valid: false, error: 'Invalid service name format' };
  }

  return { valid: true };
}

// Validate method name format
function validateMethodName(method: string): { valid: boolean; error?: string } {
  if (!method) {
    return { valid: false, error: 'Method name is required' };
  }

  const methodPattern = /^[A-Za-z][a-zA-Z0-9]*$/;
  if (!methodPattern.test(method)) {
    return { valid: false, error: 'Invalid method name format' };
  }

  return { valid: true };
}

// Parse Connect error response
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

grpcRouter.post('/', async (req: Request, res: Response) => {
  try {
    const body: GrpcProxyRequestBody = req.body;
    const { url, service, method, metadata = {}, message = {}, timeout = 30000 } = body;

    // Validate URL
    const urlValidation = validateGrpcUrl(url);
    if (!urlValidation.valid) {
      return res.status(400).json({ error: `Invalid URL: ${urlValidation.error}` });
    }

    // Validate service name
    const serviceValidation = validateServiceName(service);
    if (!serviceValidation.valid) {
      return res.status(400).json({ error: `Invalid service: ${serviceValidation.error}` });
    }

    // Validate method name
    const methodValidation = validateMethodName(method);
    if (!methodValidation.valid) {
      return res.status(400).json({ error: `Invalid method: ${methodValidation.error}` });
    }

    // Build the Connect protocol URL
    const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url;
    const connectUrl = `${baseUrl}/${service}/${method}`;

    // Prepare headers for Connect protocol
    const proxyHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
    };

    // Add user metadata as headers
    Object.entries(metadata).forEach(([key, value]) => {
      const lowerKey = key.toLowerCase();
      if (!BLOCKED_REQUEST_HEADERS.includes(lowerKey)) {
        proxyHeaders[key] = value;
      }
    });

    // Set up abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      // Make the Connect protocol request
      const response = await fetch(connectUrl, {
        method: 'POST',
        headers: proxyHeaders,
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      // Check response size before reading
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
        return res.status(413).json({ error: `Response too large (max ${MAX_RESPONSE_SIZE / 1024 / 1024}MB)` });
      }

      // Read response body
      const responseBody = await response.text();

      // Check actual size
      if (responseBody.length > MAX_RESPONSE_SIZE) {
        return res.status(413).json({ error: `Response too large (max ${MAX_RESPONSE_SIZE / 1024 / 1024}MB)` });
      }

      // Build response headers
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        if (!BLOCKED_RESPONSE_HEADERS.includes(key.toLowerCase())) {
          responseHeaders[key] = value;
        }
      });

      // Parse trailers
      const trailers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        if (key.toLowerCase().startsWith('trailer-')) {
          trailers[key.slice(8)] = value;
        }
      });

      // Determine gRPC status
      let grpcStatus: number = GrpcStatusCode.OK;
      let grpcStatusText = 'OK';
      let data: unknown = {};

      if (!response.ok) {
        const errorInfo = parseConnectError(responseBody);
        grpcStatus = errorInfo.code;
        grpcStatusText = GrpcStatusCodeName[grpcStatus] || 'UNKNOWN';
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

      return res.json(proxyResponse);
    } catch (fetchError: unknown) {
      clearTimeout(timeoutId);

      if (fetchError instanceof Error) {
        if (fetchError.name === 'AbortError') {
          return res.status(504).json({
            grpcStatus: GrpcStatusCode.DEADLINE_EXCEEDED,
            grpcStatusText: 'DEADLINE_EXCEEDED',
            headers: {},
            trailers: {},
            data: { error: `Request timeout after ${timeout}ms` },
            size: 0,
          } as GrpcProxyResponse);
        }
        return res.status(502).json({
          grpcStatus: GrpcStatusCode.UNAVAILABLE,
          grpcStatusText: 'UNAVAILABLE',
          headers: {},
          trailers: {},
          data: { error: `Proxy request failed: ${fetchError.message}` },
          size: 0,
        } as GrpcProxyResponse);
      }

      return res.status(502).json({
        grpcStatus: GrpcStatusCode.UNKNOWN,
        grpcStatusText: 'UNKNOWN',
        headers: {},
        trailers: {},
        data: { error: 'Proxy request failed' },
        size: 0,
      } as GrpcProxyResponse);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({
      grpcStatus: GrpcStatusCode.INTERNAL,
      grpcStatusText: 'INTERNAL',
      headers: {},
      trailers: {},
      data: { error: `Proxy error: ${message}` },
      size: 0,
    } as GrpcProxyResponse);
  }
});

// Handle OPTIONS for CORS preflight
grpcRouter.options('/', (_req: Request, res: Response) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(204).end();
});
