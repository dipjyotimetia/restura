import * as dns from 'dns';
import type * as http from 'http';
import * as net from 'net';
import * as diagnosticsChannel from 'node:diagnostics_channel';
import { Readable, Transform, pipeline } from 'node:stream';
import {
  text as readStreamText,
  arrayBuffer as readStreamArrayBuffer,
} from 'node:stream/consumers';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import * as tls from 'tls';
import type { ProxyBodyType, FormField } from '@shared/protocol/body-builder';
import { flattenHeaders } from '@shared/protocol/header-utils';
import { executeHttpProxy, MAX_RESPONSE_SIZE } from '@shared/protocol/http-proxy';
import type {
  Fetcher,
  FetcherRequest,
  FetcherResponse,
  ProtocolAuthConfig,
  ProtocolSecretValue as SecretValue,
} from '@shared/protocol/types';
import { assertResolvedAddressAllowed, isPrivateAddress } from '@shared/protocol/url-validation';
import { ipcMain, session } from 'electron';
import { request as undiciRequest, Agent, ProxyAgent, buildConnector } from 'undici';
import { createLogger } from '../../../src/lib/shared/logger';
import { IPC } from '../../shared/channels';
import { createKeyedRateLimiter, rateLimited } from '../ipc/ipc-rate-limiter';
import {
  HttpRequestConfigSchema,
  createValidatedHandler,
  MAX_HTTP_BODY_BYTES,
} from '../ipc/ipc-validators';
import type { LogEntry } from '../lifecycle/request-logger';
import { applyNonSignAtWireAuth } from '../security/auth-applier';
import { smithySigV4Signer } from '../security/aws-sigv4-smithy';
import { resolveEnvProxy } from '../security/env-proxy';
import { unwrapSecretValueMain } from '../security/secret-handle-store';
import { interceptorRegistry } from './interceptor-registry';

const log = createLogger('http');

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

// 6000/min (~100 rps) rather than a per-click budget: the collection runner and
// the load tester drive this channel in bursts, and a lower cap turns their
// results into self-inflicted "Rate limit exceeded" errors (the renderer is a
// trusted surface — the limiter only backstops runaway loops).
export const httpRateLimiter = createKeyedRateLimiter(6000, 60_000);

/**
 * Bring the undici fetcher to parity with the `fetch`-based backends (Worker /
 * Node self-host), which auto-decompress responses. `undici.request` does NOT —
 * it hands back the raw compressed bytes — so without this the renderer shows
 * garbage for any `Content-Encoding: gzip|br|deflate` upstream.
 *
 * The cap is enforced on the DECOMPRESSED output as it streams (a small gzip
 * bomb expands to gigabytes): bytes are counted through the chain and it is torn
 * down past MAX_RESPONSE_SIZE, so the decompressed body is never fully buffered
 * before the limit fires. Returns the source unchanged when there is nothing to
 * decode, leaving non-encoded bodies on their existing (shared-proxy) cap path.
 */
export function decodeBodyStream(source: Readable, encoding: string | undefined): Readable {
  const enc = encoding?.trim().toLowerCase();
  const decompressor =
    enc === 'gzip' || enc === 'x-gzip'
      ? createGunzip()
      : enc === 'br'
        ? createBrotliDecompress()
        : enc === 'deflate'
          ? createInflate()
          : undefined;
  if (!decompressor) return source;

  // pipeline tears down every stream (incl. the undici source, firing its
  // 'close' → dispatcher cleanup) if decompression or the cap errors; the error
  // surfaces on `cap`, so text()/arrayBuffer()/body all reject.
  const cap = createSizeCapTransform();
  pipeline(source, decompressor, cap, () => {
    /* errors surface on `cap`; nothing to do here */
  });
  return cap;
}

/**
 * A Transform that counts bytes and errors (tearing the pipeline down) once the
 * total exceeds MAX_RESPONSE_SIZE. Shared by the decode path and the
 * never-encoded body path so the cap logic + error string live in one place.
 */
function createSizeCapTransform(): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      total += chunk.length;
      if (total > MAX_RESPONSE_SIZE) {
        cb(new Error(`Response too large (max ${MAX_RESPONSE_SIZE / 1024 / 1024}MB)`));
        return;
      }
      cb(null, chunk);
    },
  });
}

/**
 * Enforce MAX_RESPONSE_SIZE on an already-decoded (or never-encoded) body as it
 * streams. Without this, the non-`Content-Encoding` path returns the raw source
 * to text()/arrayBuffer() (node:stream/consumers), which buffer the WHOLE body
 * before the post-hoc `text.length > MAX_RESPONSE_SIZE` check in http-proxy can
 * fire — a chunked response with no Content-Length OOMs the main process. This
 * tears the stream down mid-flight, mirroring decodeBodyStream's cap.
 */
function capBodyStream(source: Readable): Readable {
  const cap = createSizeCapTransform();
  pipeline(source, cap, () => {
    /* errors surface on `cap` */
  });
  return cap;
}

export interface ElectronProxyConfig {
  enabled: boolean;
  type: 'http' | 'https' | 'socks4' | 'socks5' | 'pac';
  host: string;
  port: number;
  pacUrl?: string;
  auth?: {
    username: string;
    // SecretValue per ADR-0007 — resolved to plaintext main-side via
    // unwrapSecretValueMain just before the proxy auth header / SOCKS5 handshake.
    password: SecretValue;
  };
}

interface ClientCert {
  pfx?: string;
  cert?: string;
  key?: string;
  // SecretValue per ADR-0007 — resolved main-side in buildConnectOptions.
  passphrase?: SecretValue;
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
  // Structured body (drives the shared body-builder); falls back to raw-when-data.
  bodyType?: ProxyBodyType;
  formData?: FormField[];
  timeout?: number;
  maxRedirects?: number;
  proxy?: ElectronProxyConfig;
  verifySsl?: boolean;
  clientCert?: ClientCert;
  caCert?: CaCert;
  /**
   * Sign-at-wire auth (currently AWS SigV4). Forwarded to executeHttpProxy
   * so the signature covers the exact bytes undici sends to the upstream.
   */
  auth?: ProtocolAuthConfig;
  // Redirect / URL handling (cross-platform; threaded into shared/protocol).
  followOriginalMethod?: boolean;
  followAuthHeader?: boolean;
  stripReferer?: boolean;
  encodeUrlAutomatically?: boolean;
  // TLS knobs (desktop-only enforcement).
  serverCipherOrder?: boolean;
  minTlsVersion?: 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';
  cipherSuites?: string;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string | string[]>;
  data: unknown;
  /** Decoded byte size of the response body. */
  size?: number;
  /** Set to 'base64' when `data` is base64 of a binary body (see shared/protocol/binary.ts). */
  bodyEncoding?: 'base64';
  /** Negotiated ALPN protocol (h2 or h1.1) when available — populated by undici's TLS handshake. */
  negotiatedAlpn?: 'h1.1' | 'h2' | 'h3';
}

// Connection timeout (10 seconds) — operates below the shared core's request timeout.
const CONNECTION_TIMEOUT = 10000;

function createSecureLookup(
  hostname: string,
  allowLocalhost: boolean
): NonNullable<http.RequestOptions['lookup']> {
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
          assertResolvedAddressAllowed(hostname, entry.address, {
            allowLocalhost,
            allowPrivateLiteralHost,
          });
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
function openSocksSocket(
  proxy: ElectronProxyConfig,
  targetHost: string,
  targetPort: number
): Promise<net.Socket> {
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
          Buffer.from([0x04, 0x01]),
          portBuf,
          Buffer.from([0x00, 0x00, 0x00, 0x01]), // fake IP — 0.0.0.x (x!=0) triggers SOCKS4a hostname lookup
          userId,
          hostBuf,
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
        const hasAuth = !!proxy.auth?.username;
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
              hostBuf,
              portBuf,
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

          const socksPassword = unwrapSecretValueMain(proxy.auth?.password);
          if (method === 0x00) {
            sendConnect();
          } else if (method === 0x02 && proxy.auth?.username && socksPassword) {
            const user = Buffer.from(proxy.auth.username, 'utf8');
            const pass = Buffer.from(socksPassword, 'utf8');
            const authReq = Buffer.concat([
              Buffer.from([0x01, user.length]),
              user,
              Buffer.from([pass.length]),
              pass,
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
      // Resolve the passphrase SecretValue to plaintext main-side (ADR-0007);
      // a handle never crosses back to the renderer.
      const passphrase = unwrapSecretValueMain(electronConfig.clientCert.passphrase);
      if (electronConfig.clientCert.pfx) {
        connectOpts.pfx = Buffer.from(electronConfig.clientCert.pfx, 'base64');
        if (passphrase) {
          connectOpts.passphrase = passphrase;
        }
      } else if (electronConfig.clientCert.cert && electronConfig.clientCert.key) {
        connectOpts.cert = electronConfig.clientCert.cert;
        connectOpts.key = electronConfig.clientCert.key;
        if (passphrase) {
          connectOpts.passphrase = passphrase;
        }
      }
    }
    if (electronConfig.caCert?.pem) {
      connectOpts.ca = electronConfig.caCert.pem;
    }
    // Per-request TLS knobs (Insomnia parity). Honour cipher order, custom
    // cipher list, and a minimum protocol floor. Forwarded by undici's
    // connector to `tls.connect`, where these are first-class options.
    if (electronConfig.serverCipherOrder) {
      connectOpts.honorCipherOrder = true;
    }
    if (electronConfig.cipherSuites) {
      connectOpts.ciphers = electronConfig.cipherSuites;
    }
    if (electronConfig.minTlsVersion) {
      connectOpts.minVersion = electronConfig.minTlsVersion;
    }
  }

  return connectOpts;
}

/**
 * Creates an Agent that routes connections through a pre-established SOCKS socket.
 * Replaces the Node http.Agent / https.Agent subclass that overrode createConnection
 * in the previous implementation — same idea, expressed via undici's connect factory.
 */
interface SocksTlsKnobs {
  serverCipherOrder?: boolean;
  cipherSuites?: string;
  minTlsVersion?: 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';
}

function createSocksDispatcher(
  socksSocket: net.Socket,
  targetUrl: URL,
  isHttps: boolean,
  verifySsl: boolean,
  allowH2: boolean,
  tlsKnobs?: SocksTlsKnobs
): Agent {
  // undici's connector callback type is strictly [Error, null] | [null, Socket]; assert
  // through unknown so the TLSSocket / Socket variants are accepted.
  type SocksCallback = (err: Error | null, socket: net.Socket | null) => void;
  return new Agent({
    allowH2,
    connect: ((_opts: unknown, cb: SocksCallback) => {
      try {
        if (isHttps) {
          // Match the per-request TLS knobs honoured by buildConnectOptions so
          // SOCKS-tunneled requests get the same hardening (cipher list, min
          // protocol, server cipher order).
          const tlsSocket = tls.connect({
            socket: socksSocket,
            servername: targetUrl.hostname,
            rejectUnauthorized: verifySsl,
            ALPNProtocols: allowH2 ? ['h2', 'http/1.1'] : ['http/1.1'],
            ...(tlsKnobs?.serverCipherOrder && { honorCipherOrder: true }),
            ...(tlsKnobs?.cipherSuites && { ciphers: tlsKnobs.cipherSuites }),
            ...(tlsKnobs?.minTlsVersion && { minVersion: tlsKnobs.minTlsVersion }),
          });
          tlsSocket.once('secureConnect', () => {
            // Snapshot the negotiated ALPN into the holder attached to the SOCKS socket
            // so the response builder can surface it in the response viewer.
            const holder = (socksSocket as unknown as { __alpnHolder?: { alpn?: string } })
              .__alpnHolder;
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
// Exported as a test seam so the full form-data/binary/gzip round-trip can be
// exercised against a local mock upstream without standing up IPC.
export function buildElectronFetcher(
  electronConfig: HttpRequestConfig,
  socksSocket: net.Socket | null
): Fetcher {
  return async (req: FetcherRequest): Promise<FetcherResponse> => {
    const url = new URL(req.url);
    const isHttps = url.protocol === 'https:';
    const verifySsl = electronConfig.verifySsl !== false;
    if (!verifySsl) {
      log.warn('SSL certificate verification disabled for this request');
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

    // Env-var proxy fallback (HTTP_PROXY / HTTPS_PROXY / NO_PROXY), consulted
    // only when the user has not configured an explicit proxy. resolveEnvProxy
    // honours NO_PROXY and returns undefined when the target should go direct.
    const envProxy = electronConfig.proxy?.enabled ? undefined : resolveEnvProxy(url);

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
        const proxyPassword = unwrapSecretValueMain(electronConfig.proxy.auth?.password);
        if (electronConfig.proxy.auth?.username && proxyPassword) {
          const auth = Buffer.from(
            `${electronConfig.proxy.auth.username}:${proxyPassword}`
          ).toString('base64');
          proxyOpts.token = `Basic ${auth}`;
        }
        dispatcher = new ProxyAgent(proxyOpts);
        // ProxyAgent builds the upstream connector internally from `requestTls`,
        // so we can't wrap it directly. Instead we subscribe to undici's
        // diagnostics channel for the lifetime of this request and snapshot
        // alpnProtocol from the upstream TLS socket on the 'connected' event.
        if (captureAlpn) {
          const upstreamPort = url.port ? parseInt(url.port, 10) : isHttps ? 443 : 80;
          unsubscribeProxyAlpn = subscribeProxyAlpnCapture(url.hostname, upstreamPort, alpnHolder);
        }
      } else if ((proxyType === 'socks4' || proxyType === 'socks5') && socksSocket) {
        dispatcher = createSocksDispatcher(socksSocket, url, isHttps, verifySsl, allowH2, {
          ...(electronConfig.serverCipherOrder !== undefined && {
            serverCipherOrder: electronConfig.serverCipherOrder,
          }),
          ...(electronConfig.cipherSuites !== undefined && {
            cipherSuites: electronConfig.cipherSuites,
          }),
          ...(electronConfig.minTlsVersion !== undefined && {
            minTlsVersion: electronConfig.minTlsVersion,
          }),
        });
        // SOCKS path: TLS happens inside our custom connector — capture ALPN there.
        if (isHttps) {
          (socksSocket as unknown as { __alpnHolder?: { alpn?: string } }).__alpnHolder =
            alpnHolder;
        }
      } else {
        dispatcher = new Agent({
          allowH2,
          connect: connectOpts as Parameters<typeof buildConnector>[0],
        });
      }
    } else if (envProxy) {
      // No explicit proxy configured — fall back to HTTP_PROXY / HTTPS_PROXY
      // (NO_PROXY already applied by resolveEnvProxy). Routed through undici's
      // ProxyAgent exactly like an explicit HTTP/HTTPS proxy so the upstream
      // TLS handshake (requestTls → mTLS / custom CA) and ALPN capture keep
      // working through the env proxy.
      const proxyUri = `${envProxy.type}://${envProxy.host}:${envProxy.port}`;
      const proxyOpts: ProxyAgent.Options = {
        uri: proxyUri,
        allowH2,
        requestTls: { ...connectOpts } as ProxyAgent.Options['requestTls'],
      };
      if (envProxy.auth) {
        const auth = Buffer.from(`${envProxy.auth.username}:${envProxy.auth.password}`).toString(
          'base64'
        );
        proxyOpts.token = `Basic ${auth}`;
      }
      dispatcher = new ProxyAgent(proxyOpts);
      if (captureAlpn) {
        const upstreamPort = url.port ? parseInt(url.port, 10) : isHttps ? 443 : 80;
        unsubscribeProxyAlpn = subscribeProxyAlpnCapture(url.hostname, upstreamPort, alpnHolder);
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
        try {
          unsubscribeProxyAlpn();
        } catch {
          /* ignore */
        }
        unsubscribeProxyAlpn = null;
      }
      // Fire-and-forget — close() returns a Promise but we don't need to await.
      void dispatcher.close().catch(() => {
        /* ignore */
      });
    };

    // undici accepts plain-object headers; the redirect-follower hands us a
    // Headers instance on follow-up hops, so flatten when needed. Spread-clone
    // so the FormData branch below can set Content-Type without mutating the
    // caller's headers object (flattenHeaders may return it by reference).
    const outHeaders = { ...flattenHeaders(req.headers) };

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
    } else if (typeof FormData !== 'undefined' && req.body instanceof FormData) {
      // The shared body-builder produces a web FormData for multipart bodies;
      // undici.request can't consume it directly. Serialize via the platform's
      // multipart encoder (Response) to get the bytes AND the boundary'd
      // Content-Type, then set that header — the builder left it unset because
      // the boundary isn't known until encoding.
      const encoded = new Response(req.body);
      const ct = encoded.headers.get('content-type');
      undiciBody = new Uint8Array(await encoded.arrayBuffer());
      for (const key of Object.keys(outHeaders)) {
        if (key.toLowerCase() === 'content-type') delete outHeaders[key];
      }
      if (ct) outHeaders['content-type'] = ct;
    } else {
      // Other BodyInit variants (Blob, URLSearchParams, ReadableStream) aren't
      // produced by the Electron IPC code path.
      throw new Error('Unsupported body type for Electron fetcher');
    }

    let response: Awaited<ReturnType<typeof undiciRequest>>;
    try {
      response = await undiciRequest(req.url, {
        method: req.method as Parameters<typeof undiciRequest>[1] extends infer O
          ? O extends { method?: infer M }
            ? M
            : never
          : never,
        headers: outHeaders,
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

    // Decompress to match the fetch-based backends. When we decode, the original
    // content-encoding/content-length no longer describe the body the caller
    // reads, so drop them.
    const contentEncoding = headersOut['content-encoding'];
    const bodyStream = decodeBodyStream(
      response.body,
      Array.isArray(contentEncoding) ? contentEncoding[0] : contentEncoding
    );
    const decoded = bodyStream !== response.body;
    if (decoded) {
      delete headersOut['content-encoding'];
      delete headersOut['content-length'];
    }

    // A decoded stream is already size-capped by decodeBodyStream; a non-decoded
    // body is not, so cap it here before text()/arrayBuffer()/body buffer it.
    const cappedBody = decoded ? bodyStream : capBodyStream(bodyStream);

    // Determine ALPN. Prefer explicit holder; for SOCKS we re-read the holder we attached.
    let negotiatedAlpn: 'h1.1' | 'h2' | undefined;
    let raw = alpnHolder.alpn;
    if (!raw && socksSocket) {
      raw = (socksSocket as unknown as { __alpnHolder?: { alpn?: string } }).__alpnHolder?.alpn;
    }
    if (raw === 'h2') negotiatedAlpn = 'h2';
    else if (
      raw === 'http/1.1' ||
      raw === 'http/1.0' ||
      (typeof raw === 'string' && raw.startsWith('http/1'))
    ) {
      negotiatedAlpn = 'h1.1';
    }

    const result: FetcherResponse = {
      status: response.statusCode,
      // undici doesn't expose statusText for the buffered `request` API; leave it empty.
      // Downstream (executeHttpProxy → NormalizedResponse → HttpResponse) only forwards it
      // for display; nothing branches on its value.
      statusText: '',
      headers: headersOut,
      text: () => readStreamText(cappedBody),
      arrayBuffer: () => readStreamArrayBuffer(cappedBody),
      contentLengthHeader: decoded
        ? null
        : ((response.headers['content-length'] as string | undefined) ?? null),
      // Web stream interop — undici body is a Node Readable, expose as a web ReadableStream
      // so streaming consumers (StreamingResponseViewer) can read incrementally if desired.
      body: Readable.toWeb(cappedBody) as ReadableStream<Uint8Array>,
    };
    if (negotiatedAlpn) result.negotiatedAlpn = negotiatedAlpn;
    return result;
  };
}

async function makeHttpRequest(
  config: HttpRequestConfig,
  redirectCount = 0
): Promise<HttpResponse> {
  // Check body size early, before opening any connection
  if (config.data && Buffer.byteLength(config.data, 'utf8') > MAX_HTTP_BODY_BYTES) {
    throw new Error(
      `Request body size exceeds maximum limit of ${MAX_HTTP_BODY_BYTES / 1024 / 1024}MB`
    );
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
    } catch (e) {
      // PAC resolution failed — proceed without proxy, but warn so a user who
      // configured auto-proxy (PAC) isn't silently bypassed to a direct request.
      log.warn('PAC proxy resolution failed; proceeding without proxy', {
        error: e instanceof Error ? e.message : String(e),
      });
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
    socksSocket = await openSocksSocket(
      interceptedConfig.proxy,
      socksUrl.hostname,
      socksTargetPort
    );
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
    const redirectPolicy: {
      followOriginalMethod?: boolean;
      followAuthHeader?: boolean;
      stripReferer?: boolean;
      maxRedirects?: number;
    } = {};
    if (interceptedConfig.followOriginalMethod !== undefined) {
      redirectPolicy.followOriginalMethod = interceptedConfig.followOriginalMethod;
    }
    if (interceptedConfig.followAuthHeader !== undefined) {
      redirectPolicy.followAuthHeader = interceptedConfig.followAuthHeader;
    }
    if (interceptedConfig.stripReferer !== undefined) {
      redirectPolicy.stripReferer = interceptedConfig.stripReferer;
    }
    if (interceptedConfig.maxRedirects !== undefined) {
      redirectPolicy.maxRedirects = interceptedConfig.maxRedirects;
    }
    const result = await executeHttpProxy(
      {
        method: interceptedConfig.method ?? 'GET',
        url: interceptedConfig.url,
        headers: mergedHeaders,
        params: mergedParams,
        // Honour an explicit bodyType (form-data/binary/etc.); legacy callers that
        // only send `data` keep the raw-when-present default.
        bodyType: interceptedConfig.bodyType ?? (interceptedConfig.data ? 'raw' : 'none'),
        ...(interceptedConfig.data !== undefined ? { data: interceptedConfig.data } : {}),
        ...(interceptedConfig.formData ? { formData: interceptedConfig.formData } : {}),
        ...(interceptedConfig.timeout !== undefined ? { timeout: interceptedConfig.timeout } : {}),
        ...(interceptedConfig.auth ? { auth: interceptedConfig.auth } : {}),
        ...(Object.keys(redirectPolicy).length > 0 ? { redirectPolicy } : {}),
        ...(interceptedConfig.encodeUrlAutomatically !== undefined
          ? { encodeUrl: interceptedConfig.encodeUrlAutomatically }
          : {}),
      },
      fetcher,
      {
        allowLocalhost: true,
        resolveSecret: (v) => unwrapSecretValueMain(v) ?? '',
        // Desktop signs AWS SigV4 with the official @smithy/signature-v4; the
        // Worker keeps the built-in Web-Crypto signer.
        sigV4Signer: smithySigV4Signer,
      }
    );

    if (!result.ok) {
      throw new Error(result.payload.error);
    }

    // Translate NormalizedResponse → legacy IPC HttpResponse shape (parses JSON when possible).
    // Base64 binary bodies are passed through verbatim — never JSON-parsed.
    rawResult = {
      status: result.response.status,
      statusText: result.response.statusText,
      headers: result.response.headers,
      data:
        result.response.bodyEncoding === 'base64'
          ? result.response.body
          : tryParseJson(result.response.body),
      size: result.response.size,
    };
    if (result.response.bodyEncoding) {
      rawResult.bodyEncoding = result.response.bodyEncoding;
    }
    if (result.response.negotiatedAlpn) {
      rawResult.negotiatedAlpn = result.response.negotiatedAlpn;
    }

    // Manual redirect handling — undici is configured with maxRedirections: 0.
    const isRedirect = rawResult.status >= 300 && rawResult.status < 400;
    if (isRedirect) {
      const locationHeader = rawResult.headers['location'];
      const maxRedirects = interceptedConfig.maxRedirects ?? 5;
      if (locationHeader && redirectCount < maxRedirects) {
        const locationStr = Array.isArray(locationHeader)
          ? locationHeader[0]
          : (locationHeader as string);
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
            log.error('invalid redirect URL', {
              error: err instanceof Error ? err.message : String(err),
            });
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
      createValidatedHandler(
        IPC.http.request,
        HttpRequestConfigSchema,
        async (config: HttpRequestConfig) => {
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
        }
      )
    )
  );
}
