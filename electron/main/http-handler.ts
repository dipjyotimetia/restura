import { ipcMain, session } from 'electron';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as tls from 'tls';
import * as dns from 'dns';
import { HttpRequestConfigSchema, createValidatedHandler, MAX_HTTP_BODY_BYTES } from './ipc-validators';
import { createRateLimiter } from './ipc-rate-limiter';
import { interceptorRegistry } from './interceptor-registry';
import type { LogEntry } from './request-logger';
import { assertResolvedAddressAllowed, isPrivateAddress } from '@shared/protocol/url-validation';
import { executeHttpProxy } from '@shared/protocol/http-proxy';
import type { Fetcher, FetcherRequest, FetcherResponse } from '@shared/protocol/types';

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

// Connection timeout (10 seconds) — operates below the shared core's request timeout.
const CONNECTION_TIMEOUT = 10000;

function createSecureLookup(hostname: string, allowLocalhost: boolean): NonNullable<http.RequestOptions['lookup']> {
  const allowPrivateLiteralHost = net.isIP(hostname) !== 0 && isPrivateAddress(hostname);
  return (lookupHostname, options, callback) => {
    dns.lookup(lookupHostname, options, (error, address, family) => {
      if (error) {
        callback(error, address as never, family as never);
        return;
      }
      const addresses = Array.isArray(address) ? address : [{ address, family }];
      try {
        for (const entry of addresses) {
          assertResolvedAddressAllowed(hostname, entry.address, { allowLocalhost, allowPrivateLiteralHost });
        }
        callback(null, address as never, family as never);
      } catch (err) {
        callback(err as Error, address as never, family as never);
      }
    });
  };
}

// Opens a raw TCP tunnel through a SOCKS4 or SOCKS5 proxy.
// Returns a connected net.Socket pointed at (targetHost, targetPort).
function openSocksSocket(proxy: ProxyConfig, targetHost: string, targetPort: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: proxy.host,
      port: proxy.port,
      lookup: createSecureLookup(proxy.host, true),
    });
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

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Build the Electron-side fetcher closure that the shared core invokes after URL validation,
// header sanitisation, and body building. All Electron-specific transport concerns
// (Node http/https request, SOCKS agent, mTLS, CA, connection timer, abort propagation)
// live inside this closure.
function buildElectronFetcher(
  electronConfig: HttpRequestConfig,
  socksSocket: net.Socket | null
): Fetcher {
  return (req: FetcherRequest): Promise<FetcherResponse> => {
    return new Promise<FetcherResponse>((resolve, reject) => {
      try {
        const url = new URL(req.url);
        const isHttps = url.protocol === 'https:';
        const verifySsl = electronConfig.verifySsl !== false;
        if (!verifySsl) {
          console.warn('SSL certificate verification disabled for this Electron HTTP request.');
        }

        const requestOptions: http.RequestOptions | https.RequestOptions = {
          method: req.method,
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          headers: req.headers,
          timeout: electronConfig.timeout ?? 30000,
          lookup: createSecureLookup(url.hostname, true),
        };

        // Apply proxy settings (HTTP/HTTPS or SOCKS)
        if (electronConfig.proxy?.enabled && electronConfig.proxy.host) {
          const proxyType = electronConfig.proxy.type;
          if (proxyType === 'http' || proxyType === 'https') {
            requestOptions.hostname = electronConfig.proxy.host;
            requestOptions.port = electronConfig.proxy.port;
            requestOptions.path = url.href;
            requestOptions.lookup = createSecureLookup(electronConfig.proxy.host, true);
            requestOptions.headers = {
              ...requestOptions.headers,
              Host: url.host,
            };

            if (electronConfig.proxy.auth?.username && electronConfig.proxy.auth?.password) {
              const auth = Buffer.from(
                `${electronConfig.proxy.auth.username}:${electronConfig.proxy.auth.password}`
              ).toString('base64');
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
                  return tls.connect({ socket: capturedSocket, servername, rejectUnauthorized: verifySsl });
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
          (requestOptions as https.RequestOptions).rejectUnauthorized = verifySsl;
        }

        // Apply client certificate if provided (for mTLS)
        if (isHttps && electronConfig.clientCert) {
          if (electronConfig.clientCert.pfx) {
            (requestOptions as https.RequestOptions).pfx = Buffer.from(electronConfig.clientCert.pfx, 'base64');
            if (electronConfig.clientCert.passphrase) {
              (requestOptions as https.RequestOptions).passphrase = electronConfig.clientCert.passphrase;
            }
          } else if (electronConfig.clientCert.cert && electronConfig.clientCert.key) {
            (requestOptions as https.RequestOptions).cert = electronConfig.clientCert.cert;
            (requestOptions as https.RequestOptions).key = electronConfig.clientCert.key;
            if (electronConfig.clientCert.passphrase) {
              (requestOptions as https.RequestOptions).passphrase = electronConfig.clientCert.passphrase;
            }
          }
        }

        // Apply CA certificate if provided (for custom CA / self-signed servers)
        if (isHttps && electronConfig.caCert?.pem) {
          (requestOptions as https.RequestOptions).ca = electronConfig.caCert.pem;
        }

        const protocol = isHttps ? https : http;
        const nodeReq = protocol.request(requestOptions, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
          });
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({
              status: res.statusCode || 0,
              statusText: res.statusMessage || '',
              headers: res.headers as Record<string, string | string[]>,
              text: () => Promise.resolve(text),
              contentLengthHeader: (res.headers['content-length'] as string | undefined) ?? null,
            });
          });
          res.on('error', (err: Error) => {
            reject(new Error(`Request failed: ${err.message}`));
          });
        });

        nodeReq.on('error', (err: Error) => {
          reject(new Error(`Request failed: ${err.message}`));
        });

        nodeReq.on('timeout', () => {
          nodeReq.destroy();
          reject(new Error('Request timeout'));
        });

        // Connection timeout (separate from request timeout)
        const connectionTimer = setTimeout(() => {
          nodeReq.destroy();
          reject(new Error(`Connection timeout after ${CONNECTION_TIMEOUT}ms`));
        }, CONNECTION_TIMEOUT);

        nodeReq.on('socket', (socket) => {
          socket.on('connect', () => {
            clearTimeout(connectionTimer);
          });
        });

        // Forward the abort signal from the shared core through to the Node request.
        const onAbort = () => {
          clearTimeout(connectionTimer);
          nodeReq.destroy();
        };
        if (req.signal.aborted) {
          onAbort();
        } else {
          req.signal.addEventListener('abort', onAbort, { once: true });
        }

        // Send body. The IPC contract only ever supplies a string `data`, so the shared
        // core hands us either undefined or a string here. Other BodyInit variants are
        // not currently produced by this code path.
        if (req.body !== undefined) {
          if (typeof req.body === 'string') {
            nodeReq.write(req.body);
          } else if (req.body instanceof Uint8Array) {
            nodeReq.write(Buffer.from(req.body));
          } else {
            clearTimeout(connectionTimer);
            nodeReq.destroy();
            reject(new Error('Unsupported body type for Electron fetcher'));
            return;
          }
        }
        nodeReq.end();
      } catch (err) {
        reject(err);
      }
    });
  };
}

async function makeHttpRequest(config: HttpRequestConfig, redirectCount = 0): Promise<HttpResponse> {
  // Check body size early, before opening any connection
  if (config.data && Buffer.byteLength(config.data, 'utf8') > MAX_HTTP_BODY_BYTES) {
    throw new Error(`Request body size exceeds maximum limit of ${MAX_HTTP_BODY_BYTES / 1024 / 1024}MB`);
  }

  // PAC proxy resolution (Electron-specific — uses Electron's session.resolveProxy)
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

  // Pre-establish SOCKS tunnel (must be async, before invoking the fetcher)
  let socksSocket: net.Socket | null = null;
  if (
    interceptedConfig.proxy?.enabled &&
    (interceptedConfig.proxy.type === 'socks4' || interceptedConfig.proxy.type === 'socks5')
  ) {
    const socksUrl = new URL(interceptedConfig.url);
    const socksTargetPort = parseInt(
      socksUrl.port || (socksUrl.protocol === 'https:' ? '443' : '80'),
      10
    );
    socksSocket = await openSocksSocket(interceptedConfig.proxy, socksUrl.hostname, socksTargetPort);
  }

  let rawResult: HttpResponse;
  try {
    const fetcher = buildElectronFetcher(interceptedConfig, socksSocket);
    // bodyType: 'text' makes the shared core treat `data` as a UTF-8 string body and
    // suggest 'text/plain' as Content-Type. The shared core's case-insensitive check
    // skips the Content-Type addition when the caller (renderer) has already supplied
    // one — which is the common case for HTTP requests built by the request executor.
    const result = await executeHttpProxy(
      {
        method: interceptedConfig.method ?? 'GET',
        url: interceptedConfig.url,
        ...(interceptedConfig.headers ? { headers: interceptedConfig.headers } : {}),
        ...(interceptedConfig.params ? { params: interceptedConfig.params } : {}),
        bodyType: interceptedConfig.data ? 'text' : 'none',
        ...(interceptedConfig.data !== undefined ? { data: interceptedConfig.data } : {}),
        ...(interceptedConfig.timeout !== undefined ? { timeout: interceptedConfig.timeout } : {}),
      },
      fetcher,
      { allowLocalhost: true }
    );

    if (!result.ok) {
      throw new Error(result.payload.error);
    }

    // Translate NormalizedResponse → legacy IPC HttpResponse shape (parses JSON when possible).
    rawResult = {
      status: result.response.status,
      statusText: result.response.statusText,
      headers: result.response.headers,
      data: tryParseJson(result.response.body),
    };

    // Manual redirect handling — Node http doesn't follow redirects natively.
    const isRedirect = rawResult.status >= 300 && rawResult.status < 400;
    if (isRedirect) {
      const locationHeader = rawResult.headers['location'];
      const maxRedirects = interceptedConfig.maxRedirects ?? 5;
      if (locationHeader && redirectCount < maxRedirects) {
        const locationStr = Array.isArray(locationHeader) ? locationHeader[0] : (locationHeader as string);
        if (locationStr) {
          try {
            const redirectUrl = new URL(locationStr, interceptedConfig.url).href;
            // For 301, 302, 303: change POST to GET. For 307, 308: keep original method.
            const isMethodReset =
              (rawResult.status === 301 || rawResult.status === 302 || rawResult.status === 303) &&
              interceptedConfig.method?.toUpperCase() === 'POST';
            const newMethod = isMethodReset ? 'GET' : interceptedConfig.method;

            // Destroy the SOCKS socket before recursing — the next request opens its own tunnel.
            if (socksSocket && !socksSocket.destroyed) socksSocket.destroy();

            const next: HttpRequestConfig = {
              ...interceptedConfig,
              url: redirectUrl,
              method: newMethod,
              ...(isMethodReset ? { data: undefined } : {}),
            };
            return makeHttpRequest(next, redirectCount + 1);
          } catch (err) {
            // If redirect URL is invalid, fall through and return current response.
            console.error('Invalid redirect URL:', err);
          }
        }
      }
    }
  } catch (err) {
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
