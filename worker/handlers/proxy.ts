import type { Context } from 'hono';
import { validateURL } from '../shared/url-validation';
import { MAX_RESPONSE_SIZE } from '../shared/constants';
import type { Env } from '../index';
import { httpsViaConnectProxy, httpViaProxy } from '../shared/tcp-proxy';

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

const BLOCKED_RESPONSE_HEADERS = [
  'transfer-encoding',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'trailer',
  'upgrade',
];

const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'];

interface FormField {
  name: string;
  value: string;
  filename?: string;
  contentType?: string;
}

interface UpstreamProxyConfig {
  host: string;
  port: number;
  auth?: { username: string; password: string };
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
  upstreamProxy?: UpstreamProxyConfig;
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
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
            const bytes = base64ToUint8Array(field.value);
            const blob = new Blob([bytes], { type: field.contentType || 'application/octet-stream' });
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
        return { body: base64ToUint8Array(data), contentType: 'application/octet-stream' };
      }
      return { body: undefined, contentType: undefined };
    }
    default:
      return { body: data, contentType: undefined };
  }
}

export async function proxy(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json<ProxyRequestBody>();
    const { method, url, headers = {}, params = {}, data, formData, bodyType, timeout = 30000, upstreamProxy } = body;

    if (!ALLOWED_METHODS.includes(method.toUpperCase())) {
      return c.json({ error: `Method ${method} is not allowed` }, 400);
    }

    const isDev = c.env.ENVIRONMENT === 'development';
    const urlValidation = validateURL(url, {
      allowPrivateIPs: false,
      allowLocalhost: isDev,
    });

    if (!urlValidation.valid) {
      return c.json({ error: `Invalid URL: ${urlValidation.error}` }, 400);
    }

    const targetUrl = new URL(url);
    Object.entries(params).forEach(([key, value]) => {
      targetUrl.searchParams.append(key, value);
    });

    const proxyHeaders: Record<string, string> = {};
    Object.entries(headers).forEach(([key, value]) => {
      if (!BLOCKED_REQUEST_HEADERS.includes(key.toLowerCase())) {
        proxyHeaders[key] = value;
      }
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const { body: requestBody, contentType } = buildRequestBody(bodyType, data, formData);

      if (contentType && !Object.keys(proxyHeaders).some((k) => k.toLowerCase() === 'content-type')) {
        proxyHeaders['Content-Type'] = contentType;
      }

      const fetchOptions: RequestInit = {
        method: method.toUpperCase(),
        headers: proxyHeaders,
        signal: controller.signal,
        redirect: 'follow',
      };

      if (requestBody && !['GET', 'HEAD'].includes(method.toUpperCase())) {
        fetchOptions.body = requestBody;
      }

      let response: Response;
      if (upstreamProxy) {
        // Reject hostnames with URL-injection characters before constructing the validation URL
        if (!/^[a-zA-Z0-9.\-[\]:]+$/.test(upstreamProxy.host)) {
          clearTimeout(timeoutId);
          return c.json({ error: 'Invalid proxy host: contains illegal characters' }, 400);
        }
        const proxyValidation = validateURL(`http://${upstreamProxy.host}:${upstreamProxy.port}`, {
          allowPrivateIPs: false,
          allowLocalhost: isDev,
        });
        if (!proxyValidation.valid) {
          clearTimeout(timeoutId);
          return c.json({ error: `Invalid upstream proxy: ${proxyValidation.error}` }, 400);
        }

        const isHttps = targetUrl.protocol === 'https:';
        response = isHttps
          ? await httpsViaConnectProxy(targetUrl, upstreamProxy, fetchOptions, controller.signal)
          : await httpViaProxy(targetUrl, upstreamProxy, fetchOptions, controller.signal);
      } else {
        response = await fetch(targetUrl.toString(), fetchOptions);
      }
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
      response.headers.forEach((value, key) => {
        if (!BLOCKED_RESPONSE_HEADERS.includes(key.toLowerCase())) {
          responseHeaders[key] = value;
        }
      });

      return c.json({
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
          return c.json({ error: `Request timeout after ${timeout}ms` }, 504);
        }
        return c.json({ error: `Proxy request failed: ${fetchError.message}` }, 502);
      }
      return c.json({ error: 'Proxy request failed' }, 502);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: `Proxy error: ${message}` }, 500);
  }
}
