// Desktop gRPC transports: the pinned-dial Node options shared by every wire
// protocol, and the native-gRPC → Connect fallback policy (which HTTP answers
// count as "this server doesn't speak native gRPC", the per-origin memo, and
// the ordered transport plan for one call). Split from grpc-connect.ts, which
// drives the calls over these transports.
import { isIP } from 'node:net';
import { ConnectError, type Transport } from '@connectrpc/connect';
import {
  compressionGzip,
  createConnectTransport,
  createGrpcTransport,
} from '@connectrpc/connect-node';
import { MAX_RESPONSE_SIZE } from '@shared/protocol/http-proxy';
import { buildTlsClientMaterial } from '../security/tls-material';
import type { GrpcTlsConfig } from './grpc-credentials';
import { pinnedTransportPlan, type WireProtocolArgs } from './grpc-wire-protocol';

/** A DNS-validated, pinned dial target. */
export interface PinnedDial {
  ip: string;
  port: number;
  family: 4 | 6;
}

export interface TransportArgs extends WireProtocolArgs {
  url: string;
  dial: PinnedDial;
  tls?: GrpcTlsConfig;
  /** Gzip-compress outbound messages (`sendCompression: compressionGzip`). */
  useCompression?: boolean;
  /** Inject a transport for tests (e.g. createRouterTransport). */
  transport?: Transport;
  /** Inject the Connect-fallback transport for tests (second attempt). */
  fallbackTransport?: Transport;
}

// Custom DNS lookup that pins every resolution to the pre-validated IP, closing
// the TTL=0 DNS-rebind window. Node 24's net.connect calls lookup with
// `{ all: true }` and expects an array of { address, family }; the positional
// (err, address, family) form is only used otherwise — support both.
function pinnedLookup(dial: PinnedDial) {
  return (
    _hostname: string,
    opts: { all?: boolean } | undefined,
    cb: (err: Error | null, address: unknown, family?: number) => void
  ): void => {
    if (opts?.all) cb(null, [{ address: dial.ip, family: dial.family }]);
    else cb(null, dial.ip, dial.family);
  };
}

/**
 * Canonical http(s) base URL for a dial target — also the fallback-memo key.
 * Keeps the URL's path prefix (`https://gw/grpc-web` → `/grpc-web/pkg.Svc/M`),
 * as the web relays and the CLI do; query and fragment are not part of a gRPC
 * path and are dropped.
 */
export function transportBaseUrl(url: string, dial: PinnedDial): string {
  const parsed = new URL(url);
  const useTls = url.startsWith('https://') || url.startsWith('grpcs://');
  const prefix = parsed.pathname.replace(/\/+$/, '');
  return `${useTls ? 'https' : 'http'}://${parsed.hostname}:${dial.port}${prefix}`;
}

// Shared baseUrl + Node http2/tls options + size caps for every transport flavour. The
// request's trust material (custom CA / mTLS / verify toggle) maps onto Node's options, with
// SNI + cert hostname check kept on the real hostname. readMaxBytes (SEC-G1, #929) replaces
// connect's ~4 GiB default: checked per message on the envelope length prefix BEFORE
// buffering, and handed to gzip/brotli as maxOutputLength (bombs) → RESOURCE_EXHAUSTED.
function buildNodeTransportBase(url: string, dial: PinnedDial, tls?: GrpcTlsConfig) {
  const host = new URL(url).hostname;
  const useTls = url.startsWith('https://') || url.startsWith('grpcs://');
  const baseUrl = transportBaseUrl(url, dial);

  const nodeOptions: Record<string, unknown> = { lookup: pinnedLookup(dial) };
  if (useTls) {
    // SNI + cert hostname check stay on the hostname. RFC 6066 forbids an IP
    // literal as SNI; for one, Node checks the cert against the host itself.
    const bareHost = host.replace(/^\[|\]$/g, '');
    if (isIP(bareHost) === 0) nodeOptions.servername = host;
    if (tls?.verifySsl === false) nodeOptions.rejectUnauthorized = false;
    // mTLS client cert (PKCS#12 or cert+key, with a main-resolved passphrase) +
    // custom CA. Shared with the HTTP handler so cert/CA handling can't drift.
    if (tls) Object.assign(nodeOptions, buildTlsClientMaterial(tls));
  }
  return {
    baseUrl,
    nodeOptions,
    readMaxBytes: MAX_RESPONSE_SIZE,
    writeMaxBytes: MAX_RESPONSE_SIZE,
  };
}

// Build a connect-node native-gRPC transport that dials the pinned IP.
// Exported for tests (transport options aren't observable through a live call).
export function buildConnectTransport(
  url: string,
  dial: PinnedDial,
  tls?: GrpcTlsConfig,
  useCompression?: boolean
): Transport {
  return createGrpcTransport({
    ...buildNodeTransportBase(url, dial, tls),
    // Parity with the old grpc.default_compression_algorithm=gzip channel arg.
    ...(useCompression ? { sendCompression: compressionGzip } : {}),
  });
}

/**
 * Connect-protocol transport over the same pinned dial + TLS options — the
 * fallback for servers (or edges, e.g. Cloudflare in front of a Worker) that
 * reject native gRPC at the HTTP level but speak the Connect protocol.
 */
export function buildConnectFallbackTransport(
  url: string,
  dial: PinnedDial,
  tls?: GrpcTlsConfig,
  useCompression?: boolean
): Transport {
  return createConnectTransport({
    ...buildNodeTransportBase(url, dial, tls),
    httpVersion: '2',
    ...(useCompression ? { sendCompression: compressionGzip } : {}),
  });
}

// ---------------------------------------------------------------------------
// Native-gRPC → Connect-protocol fallback
// ---------------------------------------------------------------------------

// Matches ONLY errors thrown by connect's protocol-grpc validateResponse —
// "HTTP <status>" (status ≠ 200) or "unsupported content type <mime>" — i.e.
// the peer answered HTTP but not native gRPC. A conformant gRPC server always
// returns HTTP 200 and carries errors in grpc-status trailers, whose
// ConnectError keeps the server's own message, so genuine gRPC statuses
// (including a real PERMISSION_DENIED) never match.
//
// Only statuses that mean "this request was refused, not run" qualify, since
// the fallback re-sends the call: 4xx (wrong path / method / media type, an
// edge refusing the gRPC content type) except 408 (timed out mid-request) and
// 429 (retrying makes rate limiting worse), plus 501 / 505. Other 5xx — a load
// balancer's 502/503/504 — are transient and may follow a processed call, so
// they surface as-is instead of being replayed over another protocol.
const HTTP_REJECTION_RE = /^HTTP ([1-9]\d{2})$/;
const NON_REJECTION_4XX = new Set([408, 429]);
const REJECTION_5XX = new Set([501, 505]);

export function isProtocolRejectionError(err: unknown): boolean {
  if (!(err instanceof ConnectError)) return false; // socket/TLS errors → no fallback
  if (err.rawMessage.startsWith('unsupported content type ')) return true;
  const match = HTTP_REJECTION_RE.exec(err.rawMessage);
  if (!match) return false;
  const status = Number(match[1]);
  if (status >= 400 && status < 500) return !NON_REJECTION_4XX.has(status);
  return REJECTION_5XX.has(status);
}

// Per-origin memo of "this server needs the Connect fallback" so reflection
// round-trips and later RPCs skip the doomed native attempt (bounded LRU Set).
// Recorded only once a Connect attempt has actually succeeded after native
// gRPC was refused — never on the refusal alone — and cleared as soon as the
// Connect path is itself refused or native gRPC works again, so it can't pin a
// healthy native-gRPC server to the wrong protocol.
const CONNECT_PREFERRED_MAX = 100;
const connectPreferred = new Set<string>();

function prefersConnect(baseUrl: string): boolean {
  if (!connectPreferred.has(baseUrl)) return false;
  connectPreferred.delete(baseUrl);
  connectPreferred.add(baseUrl);
  return true;
}

function noteConnectPreferred(baseUrl: string): void {
  connectPreferred.delete(baseUrl);
  connectPreferred.add(baseUrl);
  if (connectPreferred.size > CONNECT_PREFERRED_MAX) {
    const oldest = connectPreferred.values().next().value;
    if (oldest !== undefined) connectPreferred.delete(oldest);
  }
}

export function resetProtocolFallbackStateForTests(): void {
  connectPreferred.clear();
}

/** Whether an origin is currently memoised as Connect-only (exported for tests). */
export function isConnectPreferredForTests(url: string, dial: PinnedDial): boolean {
  return connectPreferred.has(transportBaseUrl(url, dial));
}

export interface TransportAttempt {
  protocol: 'grpc' | 'connect' | 'grpc-web';
  transport: Transport;
}

// Ordered transports for one call: a pinned wireProtocol (#914) is the sole attempt;
// injected (test) transports skip the implicit fallback; known-rejecting origins skip native.
export function transportPlan(t: TransportArgs): TransportAttempt[] {
  if (t.wireProtocol) return pinnedTransportPlan(t, buildNodeTransportBase) ?? [];
  if (t.transport) {
    const attempts: TransportAttempt[] = [{ protocol: 'grpc', transport: t.transport }];
    if (t.fallbackTransport) attempts.push({ protocol: 'connect', transport: t.fallbackTransport });
    return attempts;
  }
  const connect: TransportAttempt = {
    protocol: 'connect',
    transport: buildConnectFallbackTransport(t.url, t.dial, t.tls, t.useCompression),
  };
  const native: TransportAttempt = {
    protocol: 'grpc',
    transport: buildConnectTransport(t.url, t.dial, t.tls, t.useCompression),
  };
  // A memoised Connect origin still keeps native gRPC as the second attempt,
  // so a server that changed (or was memoised wrongly) heals itself.
  if (prefersConnect(transportBaseUrl(t.url, t.dial))) return [connect, native];
  return [native, connect];
}

// Memo bookkeeping for live (non-injected, non-pinned) calls.
// A refused attempt: a refused Connect attempt means the memo (if any) is wrong.
export function noteRejection(t: TransportArgs, attempt: TransportAttempt): void {
  if (t.transport || t.wireProtocol) return;
  if (attempt.protocol === 'connect') connectPreferred.delete(transportBaseUrl(t.url, t.dial));
}

// An attempt that SUCCEEDED. Connect succeeding after native was refused →
// memoise; native succeeding → the origin speaks native gRPC, forget any memo.
// Errors (a timeout, a reset, a server status) never touch the memo: they
// don't prove which protocol the origin speaks.
export function noteSettled(
  t: TransportArgs,
  attempt: TransportAttempt,
  nativeRefused: boolean
): void {
  if (t.transport || t.wireProtocol) return;
  const key = transportBaseUrl(t.url, t.dial);
  if (attempt.protocol === 'grpc') connectPreferred.delete(key);
  else if (attempt.protocol === 'connect' && nativeRefused) noteConnectPreferred(key);
}

export function combinedErrorMessage(
  rejection: { protocol: TransportAttempt['protocol']; error: ConnectError } | null,
  final: ConnectError
): string {
  if (!rejection) return final.rawMessage;
  const label = (p: TransportAttempt['protocol']) =>
    p === 'grpc' ? 'native gRPC' : p === 'connect' ? 'the Connect protocol' : 'gRPC-Web';
  const next = rejection.protocol === 'grpc' ? 'Connect protocol fallback' : 'native gRPC retry';
  return `Server rejected ${label(rejection.protocol)} (${rejection.error.rawMessage}); ${next} also failed: ${final.rawMessage}`;
}
