import { NextRequest, NextResponse } from 'next/server';
import { GrpcStatusCode, GrpcStatusCodeName } from '@/types';

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
  // Check for localhost variants
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return true;
  }

  // Check for private IP ranges
  const ipv4Pattern = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const match = hostname.match(ipv4Pattern);
  if (match) {
    const [, a, b] = match.map(Number);
    // 10.x.x.x, 172.16-31.x.x, 192.168.x.x, 169.254.x.x (link-local)
    if (a === 10) return true;
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true; // 0.0.0.0
  }

  // Check for IPv6 private ranges
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

    // SSRF protection: block private/local addresses
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

  // Service name can be in format: package.ServiceName or just ServiceName
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
      // Connect uses string codes like "not_found", "invalid_argument", etc.
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

export async function POST(request: NextRequest) {
  try {
    const body: GrpcProxyRequestBody = await request.json();
    const { url, service, method, metadata = {}, message = {}, timeout = 30000 } = body;

    // Validate URL
    const urlValidation = validateGrpcUrl(url);
    if (!urlValidation.valid) {
      return NextResponse.json(
        { error: `Invalid URL: ${urlValidation.error}` },
        { status: 400 }
      );
    }

    // Validate service name
    const serviceValidation = validateServiceName(service);
    if (!serviceValidation.valid) {
      return NextResponse.json(
        { error: `Invalid service: ${serviceValidation.error}` },
        { status: 400 }
      );
    }

    // Validate method name
    const methodValidation = validateMethodName(method);
    if (!methodValidation.valid) {
      return NextResponse.json(
        { error: `Invalid method: ${methodValidation.error}` },
        { status: 400 }
      );
    }

    // Build the Connect protocol URL
    // Format: {baseUrl}/{package.Service}/{Method}
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
        return NextResponse.json(
          { error: `Response too large (max ${MAX_RESPONSE_SIZE / 1024 / 1024}MB)` },
          { status: 413 }
        );
      }

      // Read response body
      const responseBody = await response.text();

      // Check actual size
      if (responseBody.length > MAX_RESPONSE_SIZE) {
        return NextResponse.json(
          { error: `Response too large (max ${MAX_RESPONSE_SIZE / 1024 / 1024}MB)` },
          { status: 413 }
        );
      }

      // Build response headers
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        if (!BLOCKED_RESPONSE_HEADERS.includes(key.toLowerCase())) {
          responseHeaders[key] = value;
        }
      });

      // Parse trailers (Connect sends them in headers with trailer- prefix)
      const trailers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        if (key.toLowerCase().startsWith('trailer-')) {
          trailers[key.slice(8)] = value;
        }
      });

      // Determine gRPC status
      let grpcStatus = GrpcStatusCode.OK;
      let grpcStatusText = 'OK';
      let data: unknown = {};

      if (!response.ok) {
        // Parse error response
        const errorInfo = parseConnectError(responseBody);
        grpcStatus = errorInfo.code;
        grpcStatusText = GrpcStatusCodeName[grpcStatus] || 'UNKNOWN';
        data = { error: errorInfo.message };
      } else {
        // Parse success response
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

      return NextResponse.json(proxyResponse);
    } catch (fetchError: unknown) {
      clearTimeout(timeoutId);

      if (fetchError instanceof Error) {
        if (fetchError.name === 'AbortError') {
          return NextResponse.json(
            {
              grpcStatus: GrpcStatusCode.DEADLINE_EXCEEDED,
              grpcStatusText: 'DEADLINE_EXCEEDED',
              headers: {},
              trailers: {},
              data: { error: `Request timeout after ${timeout}ms` },
              size: 0,
            } as GrpcProxyResponse,
            { status: 504 }
          );
        }
        return NextResponse.json(
          {
            grpcStatus: GrpcStatusCode.UNAVAILABLE,
            grpcStatusText: 'UNAVAILABLE',
            headers: {},
            trailers: {},
            data: { error: `Proxy request failed: ${fetchError.message}` },
            size: 0,
          } as GrpcProxyResponse,
          { status: 502 }
        );
      }

      return NextResponse.json(
        {
          grpcStatus: GrpcStatusCode.UNKNOWN,
          grpcStatusText: 'UNKNOWN',
          headers: {},
          trailers: {},
          data: { error: 'Proxy request failed' },
          size: 0,
        } as GrpcProxyResponse,
        { status: 502 }
      );
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      {
        grpcStatus: GrpcStatusCode.INTERNAL,
        grpcStatusText: 'INTERNAL',
        headers: {},
        trailers: {},
        data: { error: `Proxy error: ${message}` },
        size: 0,
      } as GrpcProxyResponse,
      { status: 500 }
    );
  }
}

// Handle OPTIONS for CORS preflight
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
