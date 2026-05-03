import { ipcMain, session } from 'electron';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as tls from 'tls';
import { HttpRequestConfigSchema, createValidatedHandler, MAX_HTTP_BODY_BYTES } from './ipc-validators';
import { createRateLimiter } from './ipc-rate-limiter';
import { interceptorRegistry } from './interceptor-registry';
import type { LogEntry } from './request-logger';

const httpRateLimiter = createRateLimiter(60, 60_000);

export interface ProxyConfig {
  enabled: boolean;
  type: 'http' | 'https' | 'socks4' | 'socks5' | 'pac';
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

interface CaCert {
  pem: string;
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
  caCert?: CaCert;
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

// Opens a raw TCP tunnel through a SOCKS4 or SOCKS5 proxy.
// Returns a connected net.Socket pointed at (targetHost, targetPort).
function openSocksSocket(proxy: ProxyConfig, targetHost: string, targetPort: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: proxy.host, port: proxy.port });
    socket.once('error', reject);

    if (proxy.type === 'socks4') {
      socket.once('connect', () => {
        // SOCKS4a: send destination IP 0.0.0.1 (non-zero last byte flags the proxy to resolve
        // the hostname itself) followed by a NUL-terminated hostname in the request tail.
        const hostBuf = Buffer.from(targetHost + '\0', 'ascii');
        const portBuf = Buffer.alloc(2);
        portBuf.writeUInt16BE(targetPort, 0);
        const userId = Buffer.from((proxy.auth?.username ?? '') + '\0', 'ascii');
        const req = Buffer.concat([
          Buffer.from([0x04, 0x01]), portBuf,
          Buffer.from([0x00, 0x00, 0x00, 0x01]), // fake IP — 0.0.0.x (x!=0) triggers SOCKS4a hostname lookup
          userId, hostBuf,
        ]);
        socket.write(req);
        socket.once('data', (data: Buffer) => {
          if (data[1] === 0x5a) {
            socket.removeListener('error', reject);
            resolve(socket);
          } else {
            socket.destroy();
            reject(new Error(`SOCKS4 proxy rejected connection (code ${data[1]})`));
          }
        });
      });
    } else {
      // SOCKS5
      socket.once('connect', () => {
        const hasAuth = !!(proxy.auth?.username);
        const greeting = hasAuth
          ? Buffer.from([0x05, 0x02, 0x00, 0x02])
          : Buffer.from([0x05, 0x01, 0x00]);
        socket.write(greeting);

        socket.once('data', (authMethodReply: Buffer) => {
          if (authMethodReply[0] !== 0x05) {
            socket.destroy();
            return reject(new Error('SOCKS5 invalid server greeting'));
          }
          const method = authMethodReply[1];

          const sendConnect = () => {
            const hostBuf = Buffer.from(targetHost, 'ascii');
            const portBuf = Buffer.alloc(2);
            portBuf.writeUInt16BE(targetPort, 0);
            const connectReq = Buffer.concat([
              Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
              hostBuf, portBuf,
            ]);
            socket.write(connectReq);
            socket.once('data', (connectReply: Buffer) => {
              if (connectReply[1] !== 0x00) {
                socket.destroy();
                return reject(new Error(`SOCKS5 connection failed (code ${connectReply[1]})`));
              }
              socket.removeListener('error', reject);
              resolve(socket);
            });
          };

          if (method === 0x00) {
            sendConnect();
          } else if (method === 0x02 && proxy.auth?.username && proxy.auth?.password) {
            const user = Buffer.from(proxy.auth.username, 'utf8');
            const pass = Buffer.from(proxy.auth.password, 'utf8');
            const authReq = Buffer.concat([
              Buffer.from([0x01, user.length]), user,
              Buffer.from([pass.length]), pass,
            ]);
            socket.write(authReq);
            socket.once('data', (authReply: Buffer) => {
              if (authReply[1] !== 0x00) {
                socket.destroy();
                return reject(new Error('SOCKS5 authentication failed'));
              }
              sendConnect();
            });
          } else {
            socket.destroy();
            reject(new Error('SOCKS5 no acceptable auth method'));
          }
        });
      });
    }
  });
}

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
      } else if (proxyResult.startsWith('SOCKS5 ')) {
        const proxyAddr = proxyResult.split(' ')[1];
        if (proxyAddr) {
          const colonIdx = proxyAddr.lastIndexOf(':');
          const host = colonIdx !== -1 ? proxyAddr.substring(0, colonIdx) : proxyAddr;
          const port = colonIdx !== -1 ? parseInt(proxyAddr.substring(colonIdx + 1), 10) : 1080;
          resolvedConfig = { ...config, proxy: { ...config.proxy!, type: 'socks5', host, port } };
        }
      } else if (proxyResult.startsWith('SOCKS ')) {
        const proxyAddr = proxyResult.split(' ')[1];
        if (proxyAddr) {
          const colonIdx = proxyAddr.lastIndexOf(':');
          const host = colonIdx !== -1 ? proxyAddr.substring(0, colonIdx) : proxyAddr;
          const port = colonIdx !== -1 ? parseInt(proxyAddr.substring(colonIdx + 1), 10) : 1080;
          resolvedConfig = { ...config, proxy: { ...config.proxy!, type: 'socks4', host, port } };
        }
      }
      // If DIRECT, proceed without proxy
    } catch {
      // PAC resolution failed — proceed without proxy
    }
  }

  const interceptedConfig = await interceptorRegistry.runRequest(resolvedConfig);

  // Pre-establish SOCKS tunnel (must be async, before Promise constructor)
  let socksSocket: net.Socket | null = null;
  if (interceptedConfig.proxy?.enabled &&
      (interceptedConfig.proxy.type === 'socks4' || interceptedConfig.proxy.type === 'socks5')) {
    const socksUrl = new URL(interceptedConfig.url);
    const socksTargetPort = parseInt(socksUrl.port || (socksUrl.protocol === 'https:' ? '443' : '80'), 10);
    socksSocket = await openSocksSocket(interceptedConfig.proxy, socksUrl.hostname, socksTargetPort);
  }

  let rawResult: HttpResponse;
  try {
    rawResult = await new Promise<HttpResponse>((resolve, reject) => {
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
        const proxyType = interceptedConfig.proxy.type;
        if (proxyType === 'http' || proxyType === 'https') {
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
        } else if ((proxyType === 'socks4' || proxyType === 'socks5') && socksSocket) {
          // Route through the pre-established SOCKS tunnel by subclassing the agent and
          // overriding createConnection — avoids monkey-patching the prototype at runtime.
          const capturedSocket = socksSocket;
          const servername = url.hostname;
          if (isHttps) {
            requestOptions.agent = new class extends https.Agent {
              override createConnection(): tls.TLSSocket {
                return tls.connect({ socket: capturedSocket, servername, rejectUnauthorized: true });
              }
            }();
          } else {
            requestOptions.agent = new class extends http.Agent {
              override createConnection(): net.Socket {
                return capturedSocket;
              }
            }();
          }
        }
      }

      // Configure SSL verification
      if (isHttps) {
        (requestOptions as https.RequestOptions).rejectUnauthorized = true;
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

      // Apply CA certificate if provided (for custom CA / self-signed servers)
      if (isHttps && interceptedConfig.caCert?.pem) {
        (requestOptions as https.RequestOptions).ca = interceptedConfig.caCert.pem;
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

  } catch (err) {
    // Destroy the SOCKS socket if the request failed before the agent could take ownership
    if (socksSocket && !socksSocket.destroyed) socksSocket.destroy();
    throw err;
  }

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
