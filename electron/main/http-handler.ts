import { ipcMain, session } from 'electron';
import * as http from 'http';
import * as https from 'https';
import { HttpRequestConfigSchema, createValidatedHandler, MAX_HTTP_BODY_BYTES } from './ipc-validators';
import { createRateLimiter } from './ipc-rate-limiter';
import { interceptorRegistry } from './interceptor-registry';
import type { LogEntry } from './request-logger';

const httpRateLimiter = createRateLimiter(60, 60_000);

export interface ProxyConfig {
  enabled: boolean;
  type: 'http' | 'https' | 'socks5' | 'pac';
  host: string;
  port: number;
  pacUrl?: string;
  auth?: {
    username: string;
    password: string;
  };
}

interface ClientCert {
  pfx?: string;
  cert?: string;
  key?: string;
  passphrase?: string;
}

export interface HttpRequestConfig {
  method: string;
  url: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  data?: string;
  timeout?: number;
  maxRedirects?: number;
  proxy?: ProxyConfig;
  verifySsl?: boolean;
  clientCert?: ClientCert;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string | string[]>;
  data: unknown;
}

// Maximum response size (10MB)
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024;

// Connection timeout (10 seconds)
const CONNECTION_TIMEOUT = 10000;

async function makeHttpRequest(config: HttpRequestConfig, redirectCount = 0): Promise<HttpResponse> {
  // Check body size early, before opening any connection
  if (config.data && Buffer.byteLength(config.data, 'utf8') > MAX_HTTP_BODY_BYTES) {
    throw new Error(`Request body size exceeds maximum limit of ${MAX_HTTP_BODY_BYTES / 1024 / 1024}MB`);
  }

  // PAC proxy resolution (before Promise constructor)
  let resolvedConfig = config;
  if (config.proxy?.enabled && config.proxy.type === 'pac' && config.proxy.pacUrl) {
    try {
      const proxyResult = await session.defaultSession.resolveProxy(config.url);
      if (proxyResult.startsWith('PROXY ') || proxyResult.startsWith('HTTPS ')) {
        const proxyAddr = proxyResult.split(' ')[1];
        if (proxyAddr) {
          const colonIdx = proxyAddr.lastIndexOf(':');
          const host = colonIdx !== -1 ? proxyAddr.substring(0, colonIdx) : proxyAddr;
          const port = colonIdx !== -1 ? parseInt(proxyAddr.substring(colonIdx + 1), 10) : 8080;
          resolvedConfig = {
            ...config,
            proxy: { ...config.proxy, type: 'http', host, port },
          };
        }
      } else if (proxyResult.startsWith('SOCKS ') || proxyResult.startsWith('SOCKS5 ')) {
        console.warn(`[HTTP] PAC resolved to SOCKS proxy but SOCKS is not supported — proceeding direct: ${proxyResult}`);
      }
      // If DIRECT, proceed without proxy
    } catch {
      // PAC resolution failed — proceed without proxy
    }
  }

  const interceptedConfig = await interceptorRegistry.runRequest(resolvedConfig);

  const rawResult = await new Promise<HttpResponse>((resolve, reject) => {
    try {
      // Parse URL and add query params
      const url = new URL(interceptedConfig.url);
      if (interceptedConfig.params) {
        Object.entries(interceptedConfig.params).forEach(([key, value]) => {
          url.searchParams.append(key, value);
        });
      }

      const isHttps = url.protocol === 'https:';

      // Build request options
      const requestOptions: http.RequestOptions | https.RequestOptions = {
        method: interceptedConfig.method || 'GET',
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        headers: interceptedConfig.headers || {},
        timeout: interceptedConfig.timeout || 30000,
      };

      // Apply proxy settings
      if (interceptedConfig.proxy?.enabled && interceptedConfig.proxy.host) {
        if (interceptedConfig.proxy.type === 'http' || interceptedConfig.proxy.type === 'https') {
          requestOptions.hostname = interceptedConfig.proxy.host;
          requestOptions.port = interceptedConfig.proxy.port;
          requestOptions.path = url.href;
          requestOptions.headers = {
            ...requestOptions.headers,
            Host: url.host,
          };

          if (interceptedConfig.proxy.auth?.username && interceptedConfig.proxy.auth?.password) {
            const auth = Buffer.from(`${interceptedConfig.proxy.auth.username}:${interceptedConfig.proxy.auth.password}`).toString('base64');
            (requestOptions.headers as Record<string, string>)['Proxy-Authorization'] = `Basic ${auth}`;
          }
        }
      }

      // Configure SSL verification
      if (isHttps && interceptedConfig.verifySsl === false) {
        (requestOptions as https.RequestOptions).rejectUnauthorized = false;
        console.warn(`[HTTP] SSL verification disabled for ${url.hostname} - this is insecure`);
      }

      // Apply client certificate if provided (for mTLS)
      if (isHttps && interceptedConfig.clientCert) {
        if (interceptedConfig.clientCert.pfx) {
          (requestOptions as https.RequestOptions).pfx = Buffer.from(interceptedConfig.clientCert.pfx, 'base64');
          if (interceptedConfig.clientCert.passphrase) {
            (requestOptions as https.RequestOptions).passphrase = interceptedConfig.clientCert.passphrase;
          }
        } else if (interceptedConfig.clientCert.cert && interceptedConfig.clientCert.key) {
          (requestOptions as https.RequestOptions).cert = interceptedConfig.clientCert.cert;
          (requestOptions as https.RequestOptions).key = interceptedConfig.clientCert.key;
          if (interceptedConfig.clientCert.passphrase) {
            (requestOptions as https.RequestOptions).passphrase = interceptedConfig.clientCert.passphrase;
          }
        }
      }

      // Create request
      const protocol = isHttps ? https : http;
      const req = protocol.request(requestOptions, (res) => {
        const chunks: Buffer[] = [];
        let totalSize = 0;

        // Check Content-Length header for early rejection
        const contentLength = res.headers['content-length'];
        if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
          req.destroy();
          reject(new Error(`Response size (${contentLength} bytes) exceeds maximum limit of ${MAX_RESPONSE_SIZE / 1024 / 1024}MB`));
          return;
        }

        res.on('data', (chunk: Buffer) => {
          totalSize += chunk.length;
          if (totalSize > MAX_RESPONSE_SIZE) {
            req.destroy();
            reject(new Error(`Response size exceeded maximum limit of ${MAX_RESPONSE_SIZE / 1024 / 1024}MB`));
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          const data = Buffer.concat(chunks).toString('utf8');
          // Parse response headers
          const headers: Record<string, string | string[]> = {};
          Object.entries(res.headers).forEach(([key, value]) => {
            if (value !== undefined) {
              headers[key] = value;
            }
          });

          const statusCode = res.statusCode || 0;

          // Handle redirects (3xx status codes)
          const isRedirect = statusCode >= 300 && statusCode < 400;
          const maxRedirects = interceptedConfig.maxRedirects ?? 5; // Default to 5 if not specified

          if (isRedirect && headers.location && redirectCount < maxRedirects) {
            // Follow redirect
            const locationHeader = Array.isArray(headers.location)
              ? headers.location[0]
              : headers.location;

            try {
              // Resolve relative URLs
              const redirectUrl = new URL(locationHeader, interceptedConfig.url).href;

              // For 301, 302, 303: Change POST to GET
              // For 307, 308: Keep original method
              const newMethod = (statusCode === 301 || statusCode === 302 || statusCode === 303)
                && interceptedConfig.method?.toUpperCase() === 'POST'
                ? 'GET'
                : interceptedConfig.method;

              // Make redirect request
              makeHttpRequest(
                {
                  ...interceptedConfig,
                  url: redirectUrl,
                  method: newMethod,
                  // Clear body for GET requests
                  data: newMethod === 'GET' ? undefined : interceptedConfig.data,
                },
                redirectCount + 1
              )
                .then(resolve)
                .catch(reject);
              return;
            } catch (err) {
              // If redirect URL is invalid, return current response
              console.error('Invalid redirect URL:', err);
            }
          }

          // Try to parse JSON response
          let responseData: unknown = data;
          try {
            responseData = JSON.parse(data);
          } catch {
            // Keep as string if not valid JSON
          }

          resolve({
            status: statusCode,
            statusText: res.statusMessage || '',
            headers,
            data: responseData,
          });
        });
      });

      // Handle errors
      req.on('error', (err) => {
        reject(new Error(`Request failed: ${err.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      // Connection timeout (separate from request timeout)
      const connectionTimer = setTimeout(() => {
        req.destroy();
        reject(new Error(`Connection timeout after ${CONNECTION_TIMEOUT}ms`));
      }, CONNECTION_TIMEOUT);

      req.on('socket', (socket) => {
        socket.on('connect', () => {
          clearTimeout(connectionTimer);
        });
      });

      // Send request body if present
      if (interceptedConfig.data) {
        req.write(interceptedConfig.data);
      }

      req.end();
    } catch (err) {
      reject(err);
    }
  });

  return interceptorRegistry.runResponse(rawResult, interceptedConfig);
}

export function registerHttpHandlerIPC(onComplete?: (entry: LogEntry) => void): void {
  ipcMain.handle(
    'http:request',
    createValidatedHandler('http:request', HttpRequestConfigSchema, async (config: HttpRequestConfig) => {
      if (!httpRateLimiter()) {
        return { error: 'Rate limit exceeded' };
      }
      const startTime = Date.now();
      let result: HttpResponse | undefined;
      let thrownError: string | undefined;
      try {
        result = await makeHttpRequest(config);
      } catch (err) {
        thrownError = err instanceof Error ? err.message : String(err);
      }
      if (onComplete) {
        onComplete({
          ts: startTime,
          method: config.method,
          url: config.url,
          status: result?.status ?? 0,
          durationMs: Date.now() - startTime,
          protocol: 'http',
          error: thrownError,
        });
      }
      if (thrownError !== undefined) throw new Error(thrownError);
      return result as HttpResponse;
    })
  );
}
