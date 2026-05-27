import { ipcMain, session } from 'electron';
import type * as http from 'http';
import * as net from 'net';
import * as tls from 'tls';
import * as dns from 'dns';
import * as diagnosticsChannel from 'node:diagnostics_channel';
import { Readable } from 'node:stream';
import { request as undiciRequest, Agent, ProxyAgent, buildConnector } from 'undici';
import { HttpRequestConfigSchema, createValidatedHandler, MAX_HTTP_BODY_BYTES } from './ipc-validators';
import { createKeyedRateLimiter, rateLimited } from './ipc-rate-limiter';
import { interceptorRegistry } from './interceptor-registry';
import type { LogEntry } from './request-logger';
import { assertResolvedAddressAllowed, isPrivateAddress } from '@shared/protocol/url-validation';
import { executeHttpProxy } from '@shared/protocol/http-proxy';
import type { Fetcher, FetcherRequest, FetcherResponse, ProtocolAuthConfig } from '@shared/protocol/types';
import { flattenHeaders } from '@shared/protocol/header-utils';
import { unwrapSecretValueMain } from './secret-handle-store';
import { applyNonSignAtWireAuth } from './auth-applier';
import { IPC } from '../shared/channels';

// =============================================================================
// Migration map (Plan 4 / Task 9): node:http/https → undici
// -----------------------------------------------------------------------------
//   node:http/https request                  → undici.request(url, options)
//   requestOptions.lookup (DNS rebind guard) → Agent({ connect: { lookup } })
//   requestOptions.rejectUnauthorized        → Agent({ connect: { rejectUnauthorized } })
//   requestOptions.{pfx,cert,key,passphrase} → Agent({ connect: { … } })  (mTLS)
//   requestOptions.ca                        → Agent({ connect: { ca } })
//   HTTP proxy                               → undici.ProxyAgent
//   SOCKS proxy (pre-established socket)     → custom Agent({ connect }) factory that
//                                              hands back the existing socket (with TLS
//                                              wrapping for HTTPS targets)
//   AbortSignal forwarding                   → passed through as `signal` to request
//   Connection timeout                       → Agent({ connect: { timeout } })
//   Manual req.write + req.end               → body: BodyInit (string | Uint8Array | …)
//   Buffered chunks via res.on('data')       → response.body.text()
//   Manual redirects (301/302/etc)           → makeHttpRequest wrapper handles it
//                                              (maxRedirections: 0 on undici call)
//   ALPN visibility                          → custom connector wraps default and
//                                              snapshots socket.alpnProtocol; surfaced
//                                              via response.negotiatedAlpn for HTTP/2
//                                              indication in the response viewer.
// =============================================================================

export const httpRateLimiter = createKeyedRateLimiter(60, 60_000);

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
  /**
   * Sign-at-wire auth (currently AWS SigV4). Forwarded to executeHttpProxy
   * so the signature covers the exact bytes undici sends to the upstream.
   */
  auth?: ProtocolAuthConfig;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string | string[]>;
  data: unknown;
  /** Negotiated ALPN protocol (h2 or h1.1) when available — populated by undici's TLS handshake. */
  negotiatedAlpn?: 'h1.1' | 'h2' | 'h3';
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

/**
 * Wraps undici's default connector to capture the negotiated ALPN protocol
 * from the underlying TLS socket. The protocol is recorded on the supplied
 * holder so the fetcher can surface it on the FetcherResponse.
 */
function wrapConnectorForAlpn(
  innerConnect: ReturnType<typeof buildConnector>,
  holder: { alpn?: string }
): ReturnType<typeof buildConnector> {
  type Cb = (err: Error | null, socket: net.Socket | null) => void;
  return ((opts: Parameters<ReturnType<typeof buildConnector>>[0], callback: Cb) => {
    innerConnect(opts, ((err: Error | null, socket: net.Socket | null) => {
      if (!err && socket) {
        // tls.TLSSocket exposes alpnProtocol; net.Socket leaves it undefined.
        const alpn = (socket as tls.TLSSocket).alpnProtocol;
        if (typeof alpn === 'string' && alpn.length > 0) {
          holder.alpn = alpn;
        }
      }
      callback(err, socket);
    }) as Parameters<ReturnType<typeof buildConnector>>[1]);
  }) as ReturnType<typeof buildConnector>;
}

/**
 * Subscribes to undici's `undici:client:connected` diagnostics channel for
 * the lifetime of a single request through an HTTP/HTTPS proxy. The TLS
 * handshake to the upstream happens inside ProxyAgent (after the CONNECT
 * tunnel) and we have no public hook to wrap that connector — so we listen
 * on the global channel and correlate by host/port from `connectParams`.
 *
 * Returns an unsubscribe function the caller MUST invoke once the request
 * finishes or errors, otherwise the listener leaks.
 */
function subscribeProxyAlpnCapture(
  hostname: string,
  port: number,
  holder: { alpn?: string }
): () => void {
  type ConnectedEvent = {
    connectParams?: { host?: string; hostname?: string; port?: number; protocol?: string };
    socket?: net.Socket | tls.TLSSocket;
  };
  const handler = (raw: unknown): void => {
    const evt = raw as ConnectedEvent;
    const cp = evt.connectParams;
    if (!cp) return;
    const cpHost = (cp.hostname ?? cp.host ?? '').toLowerCase();
    const cpPort = cp.port ?? (cp.protocol === 'https:' ? 443 : 80);
    if (cpHost !== hostname.toLowerCase() || cpPort !== port) return;
    const sock = evt.socket as tls.TLSSocket | undefined;
    const alpn = sock && 'alpnProtocol' in sock ? sock.alpnProtocol : undefined;
    if (typeof alpn === 'string' && alpn.length > 0) {
      holder.alpn = alpn;
    }
  };
  diagnosticsChannel.subscribe('undici:client:connected', handler);
  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    try {
      diagnosticsChannel.unsubscribe('undici:client:connected', handler);
    } catch {
      // ignore — best-effort cleanup
    }
  };
}

/**
 * Builds the connector options shared by every dispatcher we construct
 * (DNS rebind guard, connect timeout, mTLS material, custom CA, SSL verify flag).
 */
function buildConnectOptions(
  electronConfig: HttpRequestConfig,
  url: URL,
  isHttps: boolean,
  verifySsl: boolean
): Record<string, unknown> {
  const connectOpts: Record<string, unknown> = {
    timeout: CONNECTION_TIMEOUT,
    lookup: createSecureLookup(url.hostname, true),
  };

  if (isHttps) {
    connectOpts.rejectUnauthorized = verifySsl;
    if (electronConfig.clientCert) {
      if (electronConfig.clientCert.pfx) {
        connectOpts.pfx = Buffer.from(electronConfig.clientCert.pfx, 'base64');
        if (electronConfig.clientCert.passphrase) {
          connectOpts.passphrase = electronConfig.clientCert.passphrase;
        }
      } else if (electronConfig.clientCert.cert && electronConfig.clientCert.key) {
        connectOpts.cert = electronConfig.clientCert.cert;
        connectOpts.key = electronConfig.clientCert.key;
        if (electronConfig.clientCert.passphrase) {
          connectOpts.passphrase = electronConfig.clientCert.passphrase;
        }
      }
    }
    if (electronConfig.caCert?.pem) {
      connectOpts.ca = electronConfig.caCert.pem;
    }
  }

  return connectOpts;
}

/**
 * Creates an Agent that routes connections through a pre-established SOCKS socket.
 * Replaces the Node http.Agent / https.Agent subclass that overrode createConnection
 * in the previous implementation — same idea, expressed via undici's connect factory.
 */
function createSocksDispatcher(
  socksSocket: net.Socket,
  targetUrl: URL,
  isHttps: boolean,
  verifySsl: boolean,
  allowH2: boolean
): Agent {
  // undici's connector callback type is strictly [Error, null] | [null, Socket]; assert
  // through unknown so the TLSSocket / Socket variants are accepted.
  type SocksCallback = (err: Error | null, socket: net.Socket | null) => void;
  return new Agent({
    allowH2,
    connect: ((_opts: unknown, cb: SocksCallback) => {
      try {
        if (isHttps) {
          const tlsSocket = tls.connect({
            socket: socksSocket,
            servername: targetUrl.hostname,
            rejectUnauthorized: verifySsl,
            ALPNProtocols: allowH2 ? ['h2', 'http/1.1'] : ['http/1.1'],
          });
          tlsSocket.once('secureConnect', () => {
            // Snapshot the negotiated ALPN into the holder attached to the SOCKS socket
            // so the response builder can surface it in the response viewer.
            const holder = (socksSocket as unknown as { __alpnHolder?: { alpn?: string } }).__alpnHolder;
            if (holder && tlsSocket.alpnProtocol) {
              holder.alpn = tlsSocket.alpnProtocol;
            }
            cb(null, tlsSocket);
          });
          tlsSocket.once('error', (err) => cb(err, null));
        } else {
          // Match undici's socket contract: HTTP needs alpnProtocol set on the raw socket
          // for the dispatcher to choose H1. We set 'http/1.1' explicitly because plaintext
          // connections cannot upgrade to H2 here.
          (socksSocket as unknown as { alpnProtocol?: string }).alpnProtocol = 'http/1.1';
          cb(null, socksSocket);
        }
      } catch (err) {
        cb(err as Error, null);
      }
    }) as unknown as ReturnType<typeof buildConnector>,
  });
}

// Build the Electron-side fetcher closure that the shared core invokes after URL validation,
// header sanitisation, and body building. All Electron-specific transport concerns
// (undici dispatcher choice, SOCKS tunnel splice, mTLS, CA, connection timer, abort
// propagation, ALPN capture) live inside this closure.
function buildElectronFetcher(
  electronConfig: HttpRequestConfig,
  socksSocket: net.Socket | null
): Fetcher {
  return async (req: FetcherRequest): Promise<FetcherResponse> => {
    const url = new URL(req.url);
    const isHttps = url.protocol === 'https:';
    const verifySsl = electronConfig.verifySsl !== false;
    if (!verifySsl) {
      console.warn('SSL certificate verification disabled for this Electron HTTP request.');
    }

    const connectOpts = buildConnectOptions(electronConfig, url, isHttps, verifySsl);

    // Holder filled in by the wrapped connector after the TLS handshake.
    const alpnHolder: { alpn?: string } = {};

    // We allow HTTP/2 negotiation by default for direct/HTTP-proxy paths.
    // SOCKS path also opts in (it builds a brand new TLS socket above).
    const allowH2 = isHttps;

    // Choose a dispatcher based on proxy configuration.
    let dispatcher: Agent | ProxyAgent;
    const captureAlpn = isHttps; // only meaningful for HTTPS
    // Set if we subscribed to the global 'undici:client:connected' channel for
    // proxy-path ALPN capture; called after the request completes to avoid
    // leaking the listener across requests.
    let unsubscribeProxyAlpn: (() => void) | null = null;

    if (electronConfig.proxy?.enabled && electronConfig.proxy.host) {
      const proxyType = electronConfig.proxy.type;
      if (proxyType === 'http' || proxyType === 'https') {
        // HTTP/HTTPS proxy via undici ProxyAgent.
        const proxyUri = `${proxyType}://${electronConfig.proxy.host}:${electronConfig.proxy.port}`;
        const proxyOpts: ProxyAgent.Options = {
          uri: proxyUri,
          allowH2,
          // requestTls applies to the upstream TLS handshake — that's where mTLS and ALPN matter.
          requestTls: { ...connectOpts } as ProxyAgent.Options['requestTls'],
        };
        if (electronConfig.proxy.auth?.username && electronConfig.proxy.auth?.password) {
          const auth = Buffer.from(
            `${electronConfig.proxy.auth.username}:${electronConfig.proxy.auth.password}`
          ).toString('base64');
          proxyOpts.token = `Basic ${auth}`;
        }
        dispatcher = new ProxyAgent(proxyOpts);
        // ProxyAgent builds the upstream connector internally from `requestTls`,
        // so we can't wrap it directly. Instead we subscribe to undici's
        // diagnostics channel for the lifetime of this request and snapshot
        // alpnProtocol from the upstream TLS socket on the 'connected' event.
        if (captureAlpn) {
          const upstreamPort = url.port
            ? parseInt(url.port, 10)
            : (isHttps ? 443 : 80);
          unsubscribeProxyAlpn = subscribeProxyAlpnCapture(url.hostname, upstreamPort, alpnHolder);
        }
      } else if ((proxyType === 'socks4' || proxyType === 'socks5') && socksSocket) {
        dispatcher = createSocksDispatcher(socksSocket, url, isHttps, verifySsl, allowH2);
        // SOCKS path: TLS happens inside our custom connector — capture ALPN there.
        if (isHttps) {
          (socksSocket as unknown as { __alpnHolder?: { alpn?: string } }).__alpnHolder = alpnHolder;
        }
      } else {
        dispatcher = new Agent({
          allowH2,
          connect: connectOpts as Parameters<typeof buildConnector>[0],
        });
      }
    } else {
      // Direct connection. Wrap the default connector to capture ALPN.
      const innerConnector = buildConnector(connectOpts as Parameters<typeof buildConnector>[0]);
      dispatcher = new Agent({
        allowH2,
        connect: captureAlpn ? wrapConnectorForAlpn(innerConnector, alpnHolder) : innerConnector,
      });
    }

    // Track resources that must be released once the request completes —
    // the dispatcher (which holds connection pools, keep-alive timers, and
    // TLS contexts) and the proxy ALPN diagnostic listener. Without explicit
    // close() the dispatcher pins resources until GC, defeating undici's
    // h2 multiplexing benefits and slowly leaking sockets under high load.
    //
    // Note: we deliberately do NOT pool the dispatcher at module scope.
    // connect.lookup is per-host (createSecureLookup closes over the
    // request hostname for the DNS-rebind guard), so a shared Agent would
    // leak the wrong lookup function across hosts. Closing per-request is
    // the correct trade-off for this codebase.
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      if (unsubscribeProxyAlpn) {
        try { unsubscribeProxyAlpn(); } catch { /* ignore */ }
        unsubscribeProxyAlpn = null;
      }
      // Fire-and-forget — close() returns a Promise but we don't need to await.
      void dispatcher.close().catch(() => { /* ignore */ });
    };

    // Convert the FetcherRequest body (BodyInit | undefined) into something
    // undici accepts (string | Uint8Array | Readable | null | undefined).
    let undiciBody: string | Uint8Array | Readable | null | undefined;
    if (req.body === undefined) {
      undiciBody = undefined;
    } else if (typeof req.body === 'string') {
      undiciBody = req.body;
    } else if (req.body instanceof Uint8Array) {
      undiciBody = req.body;
    } else if (req.body instanceof ArrayBuffer) {
      undiciBody = new Uint8Array(req.body);
    } else {
      // Other BodyInit variants (Blob, FormData, URLSearchParams, ReadableStream)
      // aren't produced by the Electron IPC code path today.
      throw new Error('Unsupported body type for Electron fetcher');
    }

    // undici accepts plain-object headers; the redirect-follower hands us
    // a Headers instance on follow-up hops, so flatten when needed.
    let response: Awaited<ReturnType<typeof undiciRequest>>;
    try {
      response = await undiciRequest(req.url, {
        method: req.method as Parameters<typeof undiciRequest>[1] extends infer O
          ? O extends { method?: infer M }
            ? M
            : never
          : never,
        headers: flattenHeaders(req.headers),
        body: undiciBody,
        signal: req.signal,
        dispatcher,
        // undici's default is maxRedirections: 0 (no auto-follow); manual redirect handling
        // lives in makeHttpRequest, so we rely on that default.
      });
    } catch (err) {
      // Connection / dispatch failed — release the dispatcher and any
      // diagnostic-channel listener immediately.
      cleanup();
      // Translate undici's connect-timeout error into the legacy message shape so existing
      // callers / log output stay consistent.
      if (err instanceof Error && /connect timeout|UND_ERR_CONNECT_TIMEOUT/i.test(err.message)) {
        throw new Error(`Connection timeout after ${CONNECTION_TIMEOUT}ms`);
      }
      throw err instanceof Error ? new Error(`Request failed: ${err.message}`) : err;
    }

    // Wire up cleanup once the response body finishes (consumed via text() or
    // streamed via the web ReadableStream), errors, or the upstream signal aborts.
    response.body.once('end', cleanup);
    response.body.once('error', cleanup);
    response.body.once('close', cleanup);
    if (req.signal && !req.signal.aborted) {
      req.signal.addEventListener('abort', cleanup, { once: true });
    } else if (req.signal?.aborted) {
      // Already aborted by the time we got here — clean up immediately.
      cleanup();
    }

    // Normalise headers to Record<string, string | string[]>.
    const headersOut: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(response.headers)) {
      if (v !== undefined) headersOut[k.toLowerCase()] = v as string | string[];
    }

    // Determine ALPN. Prefer explicit holder; for SOCKS we re-read the holder we attached.
    let negotiatedAlpn: 'h1.1' | 'h2' | undefined;
    let raw = alpnHolder.alpn;
    if (!raw && socksSocket) {
      raw = (socksSocket as unknown as { __alpnHolder?: { alpn?: string } }).__alpnHolder?.alpn;
    }
    if (raw === 'h2') negotiatedAlpn = 'h2';
    else if (raw === 'http/1.1' || raw === 'http/1.0' || (typeof raw === 'string' && raw.startsWith('http/1'))) {
      negotiatedAlpn = 'h1.1';
    }

    const result: FetcherResponse = {
      status: response.statusCode,
      // undici doesn't expose statusText for the buffered `request` API; leave it empty.
      // Downstream (executeHttpProxy → NormalizedResponse → HttpResponse) only forwards it
      // for display; nothing branches on its value.
      statusText: '',
      headers: headersOut,
      text: () => response.body.text(),
      contentLengthHeader: (response.headers['content-length'] as string | undefined) ?? null,
      // Web stream interop — undici body is a Node Readable, expose as a web ReadableStream
      // so streaming consumers (StreamingResponseViewer) can read incrementally if desired.
      body: Readable.toWeb(response.body) as ReadableStream<Uint8Array>,
    };
    if (negotiatedAlpn) result.negotiatedAlpn = negotiatedAlpn;
    return result;
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
    // Apply non-sign-at-wire auth main-side for handle-protected creds.
    // (Renderer skipped this step because it can't resolve handles.)
    const mainApplied = applyNonSignAtWireAuth(interceptedConfig.auth);
    const mergedHeaders: Record<string, string> = {
      ...(interceptedConfig.headers ?? {}),
      ...mainApplied.headers,
    };
    const mergedParams: Record<string, string> = {
      ...(interceptedConfig.params ?? {}),
      ...mainApplied.params,
    };

    const fetcher = buildElectronFetcher(interceptedConfig, socksSocket);
    const result = await executeHttpProxy(
      {
        method: interceptedConfig.method ?? 'GET',
        url: interceptedConfig.url,
        headers: mergedHeaders,
        params: mergedParams,
        bodyType: interceptedConfig.data ? 'raw' : 'none',
        ...(interceptedConfig.data !== undefined ? { data: interceptedConfig.data } : {}),
        ...(interceptedConfig.timeout !== undefined ? { timeout: interceptedConfig.timeout } : {}),
        ...(interceptedConfig.auth ? { auth: interceptedConfig.auth } : {}),
      },
      fetcher,
      {
        allowLocalhost: true,
        resolveSecret: (v) => unwrapSecretValueMain(v) ?? '',
      }
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
    if (result.response.negotiatedAlpn) {
      rawResult.negotiatedAlpn = result.response.negotiatedAlpn;
    }

    // Manual redirect handling — undici is configured with maxRedirections: 0.
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
    IPC.http.request,
    rateLimited(
      httpRateLimiter,
      createValidatedHandler(IPC.http.request, HttpRequestConfigSchema, async (config: HttpRequestConfig) => {
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
    )
  );
}
