import { Readable } from 'node:stream';
import {
  arrayBuffer as readStreamArrayBuffer,
  text as readStreamText,
} from 'node:stream/consumers';
import type { FormField, ProxyBodyType } from '@shared/protocol/body-builder';
import { selectCertForUrl } from '@shared/protocol/cert-matcher';
import { flattenHeaders } from '@shared/protocol/header-utils';
import { executeHttpProxy } from '@shared/protocol/http-proxy';
import type {
  ConnectionTimings,
  Fetcher,
  FetcherRequest,
  FetcherResponse,
  ProtocolAuthConfig,
  ResponseTimings,
  ProtocolSecretValue as SecretValue,
} from '@shared/protocol/types';
import { createLogger } from '@shared/runtime/logger';
import type { HttpVersionPreference } from '@shared/types';
import { ipcMain, session } from 'electron';
import { Agent, buildConnector, ProxyAgent, request as undiciRequest } from 'undici';
import { IPC } from '../../shared/channels';
import { bindRendererCleanup, disposeByOwner } from '../ipc/connection-cleanup';
import { createKeyedRateLimiter, rateLimited } from '../ipc/ipc-rate-limiter';
import {
  createValidatedEventHandler,
  HttpCancelSchema,
  HttpRequestConfigSchema,
  MAX_HTTP_BODY_BYTES,
  type ValidatedHttpRequestConfig,
} from '../ipc/ipc-validators';
import type { LogEntry } from '../lifecycle/request-logger';
import { smithySigV4Signer } from '../security/aws-sigv4-smithy';
import { resolveEnvProxy } from '../security/env-proxy';
import {
  assertExecutionPolicyReady,
  type ExecutionPolicy,
  getExecutionPolicy,
} from '../security/execution-policy';
import { materializeHttpAuth } from '../security/http-auth-materializer';
import { isProxyBypassed } from '../security/proxy-bypass';
import { unwrapSecretValueMain } from '../security/secret-handle-store';
import { materializeSecretVariables } from '../security/secret-variable-materializer';
import { buildTlsClientMaterial } from '../security/tls-material';
import {
  withTimedLookup,
  wrapConnectorForAlpn,
  wrapConnectorForTiming,
  wrapConnectorRequireH2,
} from './http-connector-wrappers';
import { subscribeProxyAlpnCapture } from './http-proxy-alpn';
import { decodeResponseBody, tryParseJson, wireCodings } from './http-response-stream';
import { createSecureLookup, openSocksSocket } from './http-secure-connection';
import { createSocksDispatcher } from './http-socks-dispatcher';
import { h2NotNegotiatedError, resolveHttpVersionPlan } from './http-version';
import { interceptorRegistry } from './interceptor-registry';

export { decodeBodyStream } from './http-response-stream';
export { openSocksSocket } from './http-secure-connection';

const log = createLogger('http');
// Migration map: node:http/https → undici.
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
//   Manual redirects (301/302/303/307/308)   → shared followRedirects in executeHttpProxy
//                                              (undici's default: no auto-follow)
//   ALPN visibility                          → custom connector wraps default and
//                                              snapshots socket.alpnProtocol; surfaced
//                                              via response.negotiatedAlpn for HTTP/2
//                                              indication in the response viewer.

// 6000/min (~100 rps) rather than a per-click budget: the collection runner and
// the load tester drive this channel in bursts, and a lower cap turns their
// results into self-inflicted "Rate limit exceeded" errors (the renderer is a
// trusted surface — the limiter only backstops runaway loops).
export const httpRateLimiter = createKeyedRateLimiter(6000, 60_000);

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
  /** Required at the IPC boundary; optional on internal/test transport configs. */
  requestId?: string;
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
  /** HTTP version preference (#864); omitted ≡ 'auto'. */
  httpVersion?: HttpVersionPreference;
  secretVariables?: Record<string, SecretValue>;
  /** Main-process-only cancellation signal; never crosses IPC. */
  signal?: AbortSignal;
}

interface ActiveHttpRequest {
  webContentsId: number;
  abort: AbortController;
}

const activeRequests = new Map<string, ActiveHttpRequest>();

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string | string[]>;
  /** Every Set-Cookie field, one entry each (RFC 6265 §3 — never folded). */
  setCookies?: string[];
  data: unknown;
  /** Decoded byte size of the response body. */
  size?: number;
  /** Set to 'base64' when `data` is base64 of a binary body (see shared/protocol/binary.ts). */
  bodyEncoding?: 'base64';
  /** Negotiated ALPN protocol (h2 or h1.1) when available — populated by undici's TLS handshake. */
  negotiatedAlpn?: 'h1.1' | 'h2' | 'h3';
  /** Why the body was left undecoded (e.g. unsupported Content-Encoding), when it was. */
  bodyNotice?: string;
  /** Timing breakdown of the final hop (see ResponseTimings). */
  timings?: ResponseTimings;
}

function policyProxyForUrl(url: URL, policy: ExecutionPolicy): ElectronProxyConfig | undefined {
  const proxy = policy.proxy;
  const type = proxy.type;
  if (
    !proxy.enabled ||
    type === 'none' ||
    !proxy.host ||
    isProxyBypassed(url.hostname, proxy.bypassList)
  ) {
    return undefined;
  }
  return {
    enabled: proxy.enabled,
    type,
    host: proxy.host,
    port: proxy.port,
    ...(proxy.auth ? { auth: proxy.auth } : {}),
  };
}

/**
 * Fill the acknowledged desktop execution policy into an HTTP request after
 * its target URL is known. IPC-provided values are intentional per-request
 * overrides, so they always win over policy defaults.
 *
 * The returned fields are consumed directly by executeHttpProxy, Undici, and
 * the SOCKS dispatcher; keeping the fold here prevents a renderer bypass from
 * silently falling back to direct/default transport settings.
 */
export function resolveHttpExecutionPolicy(config: HttpRequestConfig): HttpRequestConfig {
  assertExecutionPolicyReady();
  const policy = getExecutionPolicy();
  const url = new URL(config.url);
  const hostClientCert = selectCertForUrl(url, policy.certificates.clientCertificates);
  const hostCaCert = selectCertForUrl(url, policy.certificates.caCertificates);

  return {
    ...config,
    timeout: config.timeout ?? policy.timeout,
    proxy: config.proxy ?? policyProxyForUrl(url, policy),
    verifySsl: config.verifySsl ?? policy.tls.verifySsl,
    clientCert: config.clientCert ?? hostClientCert?.cert ?? policy.certificates.clientCert,
    caCert: config.caCert ?? (hostCaCert ? { pem: hostCaCert.pem } : policy.certificates.caCert),
    serverCipherOrder: config.serverCipherOrder ?? policy.tls.serverCipherOrder,
    minTlsVersion: config.minTlsVersion ?? policy.tls.minTlsVersion,
    cipherSuites: config.cipherSuites ?? policy.tls.cipherSuites,
  };
}

// Connection timeout (10 seconds) — operates below the shared core's request timeout.
const CONNECTION_TIMEOUT = 10000;

/**
 * Builds the connector options shared by every dispatcher we construct
 * (DNS rebind guard, connect timeout, mTLS material, custom CA, SSL verify flag).
 */
function buildConnectOptions(
  electronConfig: HttpRequestConfig,
  url: URL,
  isHttps: boolean,
  verifySsl: boolean,
  // Pre-resolved mTLS/CA material (see buildTlsClientMaterial). Passed in rather
  // than recomputed here so the SOCKS+HTTPS path — which builds its own
  // tls.connect from the same material — doesn't resolve the secret handle and
  // base64-decode the PFX a second time.
  certMaterial: Record<string, unknown>
): Record<string, unknown> {
  const policy = getExecutionPolicy().security;
  const connectOpts: Record<string, unknown> = {
    timeout: CONNECTION_TIMEOUT,
    lookup: createSecureLookup(url.hostname, policy.allowLocalhost, policy.allowPrivateIPs),
  };

  if (isHttps) {
    connectOpts.rejectUnauthorized = verifySsl;
    Object.assign(connectOpts, certMaterial);
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

// Build the Electron-side fetcher closure that the shared core invokes after URL validation,
// header sanitisation, and body building. All Electron-specific transport concerns
// (undici dispatcher choice, SOCKS tunnel splice, mTLS, CA, connection timer, abort
// propagation, ALPN capture) live inside this closure.
// Exported as a test seam so the full form-data/binary/gzip round-trip can be
// exercised against a local mock upstream without standing up IPC.
export function buildElectronFetcher(electronConfig: HttpRequestConfig): Fetcher {
  return async (req: FetcherRequest): Promise<FetcherResponse> => {
    const url = new URL(req.url);
    const isHttps = url.protocol === 'https:';
    const signal = electronConfig.signal
      ? AbortSignal.any([req.signal, electronConfig.signal])
      : req.signal;
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

    const verifySsl = electronConfig.verifySsl !== false;
    if (!verifySsl) {
      log.warn('SSL certificate verification disabled for this request');
    }

    // Resolve mTLS/CA material once — reused by both buildConnectOptions (direct
    // + HTTP-proxy) and the SOCKS dispatcher below. Only meaningful over TLS.
    const certMaterial = isHttps ? buildTlsClientMaterial(electronConfig) : {};

    const connectOpts = buildConnectOptions(electronConfig, url, isHttps, verifySsl, certMaterial);

    // Holder filled in by the wrapped connector after the TLS handshake.
    const alpnHolder: { alpn?: string } = {};

    // HTTP version (#864). 'auto' keeps the historical behaviour: h2 offered
    // via ALPN over TLS, HTTP/1.1 over cleartext. The plan feeds every
    // dispatcher path below (direct, HTTP/env proxy, SOCKS).
    const versionPlan = resolveHttpVersionPlan(electronConfig.httpVersion, isHttps);
    const { allowH2 } = versionPlan;
    // undici's ProxyAgent sends cleartext targets as forward-proxy HTTP/1.1
    // requests; it cannot speak h2c through the proxy. Fail loudly rather than
    // silently downgrading to HTTP/1.1. (SOCKS tunnels raw TCP, so it can.)
    const assertNoH2cViaHttpProxy = (): void => {
      if (versionPlan.h2cPriorKnowledge) {
        throw new Error(
          'HTTP/2 prior knowledge (h2c) is not supported through an HTTP proxy. ' +
            'Disable the proxy for this request or use a SOCKS proxy.'
        );
      }
    };
    // ProxyAgent builds its upstream connector from requestTls, so preferH2
    // rides there to put h2 first in the ALPN list.
    const versionTls = versionPlan.preferH2 ? { preferH2: true } : {};

    // SOCKS: one tunnel per fetcher call, to THIS hop's target (the shared core
    // calls the fetcher again for a Digest retry or a followed redirect). A
    // tunnel is single-use and host-bound; undici closes it with the dispatcher.
    // Opened after every setup step that can throw, so setup never leaks it.
    // The hop URL was SSRF-validated by the shared core (every redirect hop).
    const socksProxy =
      electronConfig.proxy?.enabled &&
      electronConfig.proxy.host &&
      (electronConfig.proxy.type === 'socks4' || electronConfig.proxy.type === 'socks5')
        ? electronConfig.proxy
        : undefined;
    const socksSocket = socksProxy
      ? await openSocksSocket(
          socksProxy,
          url.hostname,
          parseInt(url.port || (isHttps ? '443' : '80'), 10),
          signal
        )
      : null;
    // Choose a dispatcher based on proxy configuration.
    let dispatcher: Agent | ProxyAgent;
    // ALPN is meaningful for TLS; for h2c prior knowledge undici stamps 'h2'
    // on the cleartext socket, which surfaces as the negotiated protocol.
    const captureAlpn = isHttps || versionPlan.h2cPriorKnowledge;
    // Set if we subscribed to the global 'undici:client:connected' channel for
    // proxy-path ALPN capture; called after the request completes to avoid
    // leaking the listener across requests.
    let unsubscribeProxyAlpn: (() => void) | null = null;
    // Connection phases of the direct path; stays empty when proxied.
    const connectionTimings: ConnectionTimings = {};

    // Env-var proxy fallback (HTTP_PROXY / HTTPS_PROXY / NO_PROXY), consulted
    // only when the user has not configured an explicit proxy. resolveEnvProxy
    // honours NO_PROXY and returns undefined when the target should go direct.
    const envProxy = electronConfig.proxy?.enabled ? undefined : resolveEnvProxy(url);

    if (electronConfig.proxy?.enabled && electronConfig.proxy.host) {
      const proxyType = electronConfig.proxy.type;
      if (proxyType === 'http' || proxyType === 'https') {
        // HTTP/HTTPS proxy via undici ProxyAgent.
        assertNoH2cViaHttpProxy();
        const proxyUri = `${proxyType}://${electronConfig.proxy.host}:${electronConfig.proxy.port}`;
        const proxyOpts: ProxyAgent.Options = {
          uri: proxyUri,
          allowH2,
          // requestTls applies to the upstream TLS handshake — that's where mTLS and ALPN matter.
          requestTls: { ...connectOpts, ...versionTls } as ProxyAgent.Options['requestTls'],
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
      } else if (socksSocket) {
        dispatcher = createSocksDispatcher(
          socksSocket,
          url,
          isHttps,
          verifySsl,
          versionPlan,
          {
            ...(electronConfig.serverCipherOrder !== undefined && {
              serverCipherOrder: electronConfig.serverCipherOrder,
            }),
            ...(electronConfig.cipherSuites !== undefined && {
              cipherSuites: electronConfig.cipherSuites,
            }),
            ...(electronConfig.minTlsVersion !== undefined && {
              minTlsVersion: electronConfig.minTlsVersion,
            }),
          },
          // mTLS client cert + custom CA — previously dropped on the SOCKS path.
          certMaterial
        );
        // SOCKS path: TLS happens inside our custom connector — capture ALPN there.
        if (captureAlpn) {
          (socksSocket as unknown as { __alpnHolder?: { alpn?: string } }).__alpnHolder =
            alpnHolder;
        }
      } else {
        dispatcher = new Agent({
          allowH2,
          connect: {
            ...connectOpts,
            ...versionTls,
            ...(versionPlan.h2cPriorKnowledge ? { useH2c: true } : {}),
          } as Parameters<typeof buildConnector>[0],
        });
      }
    } else if (envProxy) {
      // No explicit proxy configured — fall back to HTTP_PROXY / HTTPS_PROXY
      // (NO_PROXY already applied by resolveEnvProxy). Routed through undici's
      // ProxyAgent exactly like an explicit HTTP/HTTPS proxy so the upstream
      // TLS handshake (requestTls → mTLS / custom CA) and ALPN capture keep
      // working through the env proxy.
      assertNoH2cViaHttpProxy();
      const proxyUri = `${envProxy.type}://${envProxy.host}:${envProxy.port}`;
      const proxyOpts: ProxyAgent.Options = {
        uri: proxyUri,
        allowH2,
        requestTls: { ...connectOpts, ...versionTls } as ProxyAgent.Options['requestTls'],
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
      // Direct connection. Wrap the default connector to capture ALPN, and
      // time DNS (the lookup) and the connector (TCP + TLS). The Agent is
      // per-request, so every request opens — and times — its own connection.
      // Proxied paths are not timed: the phases would describe the proxy.
      // The version plan must reach buildConnector itself: it computes the
      // ALPN list (and the h2c marker) from its own options, ignoring the
      // Agent-level allowH2 once a custom connect function is supplied.
      const innerConnector = buildConnector({
        ...withTimedLookup(connectOpts, connectionTimings),
        allowH2,
        ...versionTls,
        ...(versionPlan.h2cPriorKnowledge ? { useH2c: true } : {}),
      } as Parameters<typeof buildConnector>[0]);
      const alpnConnector = captureAlpn
        ? wrapConnectorForAlpn(innerConnector, alpnHolder)
        : innerConnector;
      dispatcher = new Agent({
        allowH2,
        connect: wrapConnectorForTiming(
          versionPlan.requireH2
            ? wrapConnectorRequireH2(alpnConnector, h2NotNegotiatedError)
            : alpnConnector,
          connectionTimings
        ),
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
        signal,
        dispatcher,
        // undici's default is no auto-follow; redirects are followed (and
        // credentials stripped cross-origin) by the shared followRedirects.
      });
    } catch (err) {
      // Connection / dispatch failed — release the dispatcher, the SOCKS
      // tunnel, and any diagnostic-channel listener immediately.
      cleanup();
      if (socksSocket && !socksSocket.destroyed) socksSocket.destroy();
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

    // Decode (ordered Content-Encoding list) + size-cap. Once decoded, content-encoding/
    // -length no longer describe the body, so drop them; unsupported codings stay raw.
    const {
      body: cappedBody,
      decoded,
      notice: bodyNotice,
    } = decodeResponseBody(response.body, wireCodings(req.method, response.statusCode, headersOut));
    if (decoded) {
      delete headersOut['content-encoding'];
      delete headersOut['content-length'];
    }

    // Determine ALPN. Prefer explicit holder; for SOCKS we re-read the holder we attached.
    let negotiatedAlpn: 'h1.1' | 'h2' | undefined;
    let raw = alpnHolder.alpn;
    if (!raw && socksSocket) {
      raw = (socksSocket as unknown as { __alpnHolder?: { alpn?: string } }).__alpnHolder?.alpn;
    }
    // Backstop for paths whose connector we don't own (HTTP/env ProxyAgent):
    // a required h2 that wasn't negotiated is an error, not a silent HTTP/1.1.
    if (versionPlan.requireH2 && raw !== 'h2') {
      cleanup();
      response.body.destroy();
      throw h2NotNegotiatedError(raw);
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
    if (bodyNotice) result.bodyNotice = bodyNotice;
    if (connectionTimings.connect !== undefined)
      result.connectionTimings = { ...connectionTimings };
    return result;
  };
}

// Redirects are owned by the shared follower inside executeHttpProxy (per-hop
// SSRF re-validation + cross-origin credential stripping). Any 3xx it hands
// back — 300/304/305/306, or a hop past maxRedirects=0 — is returned as-is,
// never re-sent with the original credentials.
async function makeHttpRequest(config: HttpRequestConfig): Promise<HttpResponse> {
  config = await materializeSecretVariables(config, config.signal);
  let policyConfig: HttpRequestConfig;
  try {
    policyConfig = resolveHttpExecutionPolicy(config);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Execution policy rejected: ${detail}`);
  }

  // Check body size early, before opening any connection
  if (policyConfig.data && Buffer.byteLength(policyConfig.data, 'utf8') > MAX_HTTP_BODY_BYTES) {
    throw new Error(
      `Request body size exceeds maximum limit of ${MAX_HTTP_BODY_BYTES / 1024 / 1024}MB`
    );
  }

  // PAC proxy resolution (Electron-specific — uses Electron's session.resolveProxy)
  let resolvedConfig = policyConfig;
  if (
    policyConfig.proxy?.enabled &&
    policyConfig.proxy.type === 'pac' &&
    policyConfig.proxy.pacUrl
  ) {
    try {
      const proxyResult = await session.defaultSession.resolveProxy(policyConfig.url);
      if (proxyResult.startsWith('PROXY ') || proxyResult.startsWith('HTTPS ')) {
        const proxyAddr = proxyResult.split(' ')[1];
        if (proxyAddr) {
          const colonIdx = proxyAddr.lastIndexOf(':');
          const host = colonIdx !== -1 ? proxyAddr.substring(0, colonIdx) : proxyAddr;
          const port = colonIdx !== -1 ? parseInt(proxyAddr.substring(colonIdx + 1), 10) : 8080;
          resolvedConfig = {
            ...policyConfig,
            proxy: { ...policyConfig.proxy, type: 'http', host, port },
          };
        }
      } else if (proxyResult.startsWith('SOCKS5 ')) {
        const proxyAddr = proxyResult.split(' ')[1];
        if (proxyAddr) {
          const colonIdx = proxyAddr.lastIndexOf(':');
          const host = colonIdx !== -1 ? proxyAddr.substring(0, colonIdx) : proxyAddr;
          const port = colonIdx !== -1 ? parseInt(proxyAddr.substring(colonIdx + 1), 10) : 1080;
          resolvedConfig = {
            ...policyConfig,
            proxy: { ...policyConfig.proxy!, type: 'socks5', host, port },
          };
        }
      } else if (proxyResult.startsWith('SOCKS ')) {
        const proxyAddr = proxyResult.split(' ')[1];
        if (proxyAddr) {
          const colonIdx = proxyAddr.lastIndexOf(':');
          const host = colonIdx !== -1 ? proxyAddr.substring(0, colonIdx) : proxyAddr;
          const port = colonIdx !== -1 ? parseInt(proxyAddr.substring(colonIdx + 1), 10) : 1080;
          resolvedConfig = {
            ...policyConfig,
            proxy: { ...policyConfig.proxy!, type: 'socks4', host, port },
          };
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

  const mainAuth = await materializeHttpAuth(interceptedConfig);

  const fetcher = buildElectronFetcher(interceptedConfig);
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
      headers: mainAuth.headers,
      params: mainAuth.params,
      // Honour an explicit bodyType (form-data/binary/etc.); legacy callers that
      // only send `data` keep the raw-when-present default.
      bodyType: interceptedConfig.bodyType ?? (interceptedConfig.data ? 'raw' : 'none'),
      ...(interceptedConfig.data !== undefined ? { data: interceptedConfig.data } : {}),
      ...(interceptedConfig.formData ? { formData: interceptedConfig.formData } : {}),
      ...(interceptedConfig.timeout !== undefined ? { timeout: interceptedConfig.timeout } : {}),
      ...(mainAuth.auth ? { auth: mainAuth.auth } : {}),
      ...(Object.keys(redirectPolicy).length > 0 ? { redirectPolicy } : {}),
      ...(interceptedConfig.encodeUrlAutomatically !== undefined
        ? { encodeUrl: interceptedConfig.encodeUrlAutomatically }
        : {}),
    },
    fetcher,
    {
      // Shared outbound-network policy (Settings → Security), same snapshot
      // every desktop transport reads. Cloud metadata stays blocked inside
      // the shared URL guard regardless.
      ...getExecutionPolicy().security,
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
  const rawResult: HttpResponse = {
    status: result.response.status,
    statusText: result.response.statusText,
    headers: result.response.headers,
    data:
      result.response.bodyEncoding === 'base64'
        ? result.response.body
        : tryParseJson(result.response.body),
    size: result.response.size,
    ...(result.response.setCookies && { setCookies: result.response.setCookies }),
    ...(result.response.bodyEncoding && { bodyEncoding: result.response.bodyEncoding }),
    ...(result.response.negotiatedAlpn && { negotiatedAlpn: result.response.negotiatedAlpn }),
    ...(result.response.bodyNotice && { bodyNotice: result.response.bodyNotice }),
    ...(result.response.timings && { timings: result.response.timings }),
  };

  return interceptorRegistry.runResponse(rawResult, interceptedConfig);
}

/** Materialize opaque SecretRef variables only in Electron main, before the wire request. */
export function registerHttpHandlerIPC(onComplete?: (entry: LogEntry) => void): void {
  ipcMain.handle(
    IPC.http.request,
    rateLimited(
      httpRateLimiter,
      createValidatedEventHandler(
        IPC.http.request,
        HttpRequestConfigSchema,
        async (config: ValidatedHttpRequestConfig, event) => {
          const activeRequest: ActiveHttpRequest = {
            webContentsId: event.sender.id,
            abort: new AbortController(),
          };
          if (activeRequests.has(config.requestId)) {
            throw new Error('A request with this request ID is already active.');
          }
          activeRequests.set(config.requestId, activeRequest);
          bindRendererCleanup(activeRequests, event.sender, (deadId) => {
            disposeByOwner(activeRequests, deadId, (entry) => entry.abort.abort());
          });
          const startTime = Date.now();
          let result: HttpResponse | undefined;
          let thrownError: string | undefined;
          try {
            result = await makeHttpRequest({ ...config, signal: activeRequest.abort.signal });
          } catch (err) {
            thrownError = err instanceof Error ? err.message : String(err);
          } finally {
            // Identity check prevents an older completion from deleting a newer
            // request that legitimately reused the ID after owner cleanup.
            if (activeRequests.get(config.requestId) === activeRequest) {
              activeRequests.delete(config.requestId);
            }
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
  ipcMain.handle(
    IPC.http.cancel,
    createValidatedEventHandler(IPC.http.cancel, HttpCancelSchema, async ({ requestId }, event) => {
      const active = activeRequests.get(requestId);
      if (!active) return { ok: true as const, alreadyDone: true as const };
      if (active.webContentsId !== event.sender.id) {
        return { ok: false as const, error: 'Request does not belong to this renderer.' };
      }
      // Keep the entry registered until the request handler's finally block.
      // This makes repeated cancel idempotent and prevents same-ID reuse while
      // the cancelled transport is still unwinding.
      active.abort.abort();
      return { ok: true as const };
    })
  );
}
