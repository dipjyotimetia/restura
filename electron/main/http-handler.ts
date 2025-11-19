import { ipcMain } from 'electron';
import * as http from 'http';
import * as https from 'https';

interface ProxyConfig {
  enabled: boolean;
  type: string;
  host: string;
  port: number;
  auth?: {
    username: string;
    password: string;
  };
}

interface HttpRequestConfig {
  method: string;
  url: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  data?: string;
  timeout?: number;
  maxRedirects?: number;
  proxy?: ProxyConfig;
  verifySsl?: boolean;
}

interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string | string[]>;
  data: unknown;
}

function makeHttpRequest(config: HttpRequestConfig, redirectCount = 0): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    try {
      // Parse URL and add query params
      const url = new URL(config.url);
      if (config.params) {
        Object.entries(config.params).forEach(([key, value]) => {
          url.searchParams.append(key, value);
        });
      }

      const isHttps = url.protocol === 'https:';

      // Build request options
      const requestOptions: http.RequestOptions | https.RequestOptions = {
        method: config.method || 'GET',
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        headers: config.headers || {},
        timeout: config.timeout || 30000,
      };

      // Apply proxy settings
      if (config.proxy?.enabled && config.proxy.host) {
        if (config.proxy.type === 'http' || config.proxy.type === 'https') {
          requestOptions.hostname = config.proxy.host;
          requestOptions.port = config.proxy.port;
          requestOptions.path = url.href;
          requestOptions.headers = {
            ...requestOptions.headers,
            Host: url.host,
          };

          if (config.proxy.auth?.username && config.proxy.auth?.password) {
            const auth = Buffer.from(`${config.proxy.auth.username}:${config.proxy.auth.password}`).toString('base64');
            (requestOptions.headers as Record<string, string>)['Proxy-Authorization'] = `Basic ${auth}`;
          }
        }
      }

      // Configure SSL verification
      if (isHttps && !config.verifySsl) {
        (requestOptions as https.RequestOptions).rejectUnauthorized = false;
      }

      // Create request
      const protocol = isHttps ? https : http;
      const req = protocol.request(requestOptions, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
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
          const maxRedirects = config.maxRedirects ?? 5; // Default to 5 if not specified

          if (isRedirect && headers.location && redirectCount < maxRedirects) {
            // Follow redirect
            const locationHeader = Array.isArray(headers.location)
              ? headers.location[0]
              : headers.location;

            try {
              // Resolve relative URLs
              const redirectUrl = new URL(locationHeader, config.url).href;

              // For 301, 302, 303: Change POST to GET
              // For 307, 308: Keep original method
              const newMethod = (statusCode === 301 || statusCode === 302 || statusCode === 303)
                && config.method?.toUpperCase() === 'POST'
                ? 'GET'
                : config.method;

              // Make redirect request
              makeHttpRequest(
                {
                  ...config,
                  url: redirectUrl,
                  method: newMethod,
                  // Clear body for GET requests
                  data: newMethod === 'GET' ? undefined : config.data,
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

      // Send request body if present
      if (config.data) {
        req.write(config.data);
      }

      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

export function registerHttpHandlerIPC(): void {
  ipcMain.handle('http:request', async (_event, config: HttpRequestConfig) => {
    return makeHttpRequest(config);
  });
}
