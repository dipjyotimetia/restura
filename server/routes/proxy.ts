import { Router, Request, Response } from 'express';

export const proxyRouter = Router();

// Headers that should not be forwarded
const BLOCKED_REQUEST_HEADERS = [
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
];

// Headers that should not be forwarded back to client
const BLOCKED_RESPONSE_HEADERS = [
  'transfer-encoding',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'trailer',
  'upgrade',
];

// Maximum response body size (10MB)
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024;

// Allowed HTTP methods
const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'];

interface FormField {
  name: string;
  value: string;
  filename?: string;
  contentType?: string;
}

interface ProxyRequestBody {
  method: string;
  url: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  bodyType?: 'json' | 'text' | 'form-urlencoded' | 'form-data' | 'binary' | 'none';
  data?: string;
  formData?: FormField[];
  timeout?: number;
}

function buildRequestBody(
  bodyType: string | undefined,
  data: string | undefined,
  formData: FormField[] | undefined
): { body: BodyInit | undefined; contentType: string | undefined } {
  if (!bodyType || bodyType === 'none') {
    return { body: undefined, contentType: undefined };
  }

  switch (bodyType) {
    case 'json':
      return { body: data, contentType: 'application/json' };

    case 'text':
      return { body: data, contentType: 'text/plain' };

    case 'form-urlencoded': {
      const params = new URLSearchParams();
      if (formData) {
        formData.forEach((field) => {
          params.append(field.name, field.value);
        });
      } else if (data) {
        return { body: data, contentType: 'application/x-www-form-urlencoded' };
      }
      return { body: params.toString(), contentType: 'application/x-www-form-urlencoded' };
    }

    case 'form-data': {
      const formDataObj = new FormData();
      if (formData) {
        formData.forEach((field) => {
          if (field.filename) {
            const buffer = Buffer.from(field.value, 'base64');
            const blob = new Blob([buffer], { type: field.contentType || 'application/octet-stream' });
            formDataObj.append(field.name, blob, field.filename);
          } else {
            formDataObj.append(field.name, field.value);
          }
        });
      }
      return { body: formDataObj, contentType: undefined };
    }

    case 'binary': {
      if (data) {
        const buffer = Buffer.from(data, 'base64');
        return { body: buffer, contentType: 'application/octet-stream' };
      }
      return { body: undefined, contentType: undefined };
    }

    default:
      return { body: data, contentType: undefined };
  }
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

function validateURL(url: string, options: { allowPrivateIPs: boolean; allowLocalhost: boolean }): { valid: boolean; error?: string } {
  if (!url) {
    return { valid: false, error: 'URL is required' };
  }

  try {
    const parsed = new URL(url);

    if (!options.allowPrivateIPs && isPrivateAddress(parsed.hostname)) {
      return { valid: false, error: 'Private IP addresses are not allowed' };
    }

    if (!options.allowLocalhost && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')) {
      return { valid: false, error: 'Localhost is not allowed' };
    }

    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
}

proxyRouter.post('/', async (req: Request, res: Response) => {
  try {
    const body: ProxyRequestBody = req.body;
    const { method, url, headers = {}, params = {}, data, formData, bodyType, timeout = 30000 } = body;

    // Validate method
    if (!ALLOWED_METHODS.includes(method.toUpperCase())) {
      return res.status(400).json({ error: `Method ${method} is not allowed` });
    }

    // Validate URL
    const urlValidation = validateURL(url, {
      allowPrivateIPs: false,
      allowLocalhost: process.env.NODE_ENV === 'development',
    });

    if (!urlValidation.valid) {
      return res.status(400).json({ error: `Invalid URL: ${urlValidation.error}` });
    }

    // Build target URL with query params
    const targetUrl = new URL(url);
    Object.entries(params).forEach(([key, value]) => {
      targetUrl.searchParams.append(key, value);
    });

    // Filter and prepare headers
    const proxyHeaders: Record<string, string> = {};
    Object.entries(headers).forEach(([key, value]) => {
      if (!BLOCKED_REQUEST_HEADERS.includes(key.toLowerCase())) {
        proxyHeaders[key] = value;
      }
    });

    // Set up abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      // Build request body based on type
      const { body: requestBody, contentType } = buildRequestBody(bodyType, data, formData);

      // Set content-type if provided by body builder and not already set
      if (contentType && !Object.keys(proxyHeaders).some(k => k.toLowerCase() === 'content-type')) {
        proxyHeaders['Content-Type'] = contentType;
      }

      // Make the proxied request
      const fetchOptions: RequestInit = {
        method: method.toUpperCase(),
        headers: proxyHeaders,
        signal: controller.signal,
        redirect: 'follow',
      };

      // Add body for non-GET/HEAD requests
      if (requestBody && !['GET', 'HEAD'].includes(method.toUpperCase())) {
        fetchOptions.body = requestBody;
      }

      const response = await fetch(targetUrl.toString(), fetchOptions);
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

      // Return proxied response
      return res.json({
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        data: responseBody,
        size: responseBody.length,
      });
    } catch (fetchError: unknown) {
      clearTimeout(timeoutId);

      if (fetchError instanceof Error) {
        if (fetchError.name === 'AbortError') {
          return res.status(504).json({ error: `Request timeout after ${timeout}ms` });
        }
        return res.status(502).json({ error: `Proxy request failed: ${fetchError.message}` });
      }

      return res.status(502).json({ error: 'Proxy request failed' });
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({ error: `Proxy error: ${message}` });
  }
});

// Handle OPTIONS for CORS preflight
proxyRouter.options('/', (_req: Request, res: Response) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(204).end();
});
