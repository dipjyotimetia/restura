import type { Fetcher } from '@shared/protocol/types';
import type { ExternalSecretResolver } from '@shared/secrets/external-secret-resolver';
import type { Dispatcher } from 'undici';
import type { LoadedRequest } from '../collectionLoader';
import type { CliMcpSessionPool } from '../mcpSession';
import type { TlsOptions } from '../undiciFetcher';

/** Streaming event captured from SSE or WebSocket runs. */
export interface StreamEvent {
  /** SSE: event name; WS: 'message' / 'open' / 'close'. */
  event?: string;
  /** Raw payload as text. Binary WS frames are base64'd. */
  data: string;
  /** Unix ms. */
  timestamp: number;
}

/** gRPC status — surfaced separately from HTTP status because they're orthogonal. */
export interface GrpcStatusInfo {
  code: number;
  message: string;
}

export interface ExecuteOutcome {
  /** HTTP status code, or 0 for stream protocols / errors. */
  status: number;
  /** Whether the request itself succeeded at the transport layer. Script assertions can override this in the runner. */
  passed: boolean;
  durationMs: number;
  bodyBytes: number;
  responseHeaders?: Record<string, string>;
  /** Every Set-Cookie field, one entry each (RFC 6265 §3 — never folded). */
  setCookies?: string[];
  responseBody?: string;
  /** gRPC trailing metadata (`rs.response.trailers` in test scripts). */
  responseTrailers?: Record<string, string>;
  errorMessage?: string;
  /**
   * A protocol-level failure test assertions may override (MCP: a JSON-RPC
   * error or a tool result with `isError: true`). Unlike `errorMessage` it
   * does not force a fail; the runner reports it only when no assertion ran.
   */
  protocolError?: string;
  grpcStatus?: GrpcStatusInfo;
  streamEvents?: StreamEvent[];
  /**
   * Set when the CLI refused the request or its answer by a deterministic rule:
   * before any I/O (blocked at load, an unresolvable variable or secret, an auth
   * scheme or URL the CLI will not send), or in the shared core (an SSRF or
   * redirect-policy block, an auth signing failure, the response-size cap).
   * Retrying can never succeed, so it is never retried (see `failure.ts`).
   */
  refused?: true;
  /**
   * Set when no upstream response was received: the connection failed, DNS
   * did not resolve, or the call timed out before any answer. `--retry-on
   * network` matches this marker and nothing else.
   */
  transportError?: true;
}

/** A cached OAuth2 token: `expiresAt` epoch ms, undefined = no expiry info. */
export interface CachedOAuth2Token {
  accessToken: string;
  tokenType: string;
  expiresAt?: number;
  /**
   * The client secret the token was issued for. The cache key leaves the
   * secret out (it is never hashed or logged); a lookup reuses the token only
   * when this matches, so a rotated secret never gets the old token.
   */
  clientSecret?: string;
}

export type OAuth2TokenCache = Map<string, CachedOAuth2Token>;

export interface ExecuteOptions {
  vars: Record<string, string>;
  timeoutMs: number;
  allowLocalhost: boolean;
  /** Propagates agent cancellation to the shared HTTP fetch controller. */
  signal?: AbortSignal;
  /** SSE: max time to keep the stream open (ms). Default 5000. */
  sseDurationMs?: number;
  /** SSE: stop early after this many events. Default unbounded within duration. */
  sseMaxEvents?: number;
  /** WebSocket: max time to hold the socket open (ms). Default 5000. */
  wsDurationMs?: number;
  /** WebSocket: stop early after this many incoming messages. Default unbounded within duration. */
  wsMaxMessages?: number;
  /** undici dispatcher carrying TLS options (custom CA / mTLS / insecure). Built once per run. */
  dispatcher?: Dispatcher;
  /** TLS options, re-applied by executors that build a DNS-pinned connection (MCP). */
  tls?: TlsOptions;
  /** Explicit `--proxy` URL (MCP cannot pin DNS through a proxy). */
  proxy?: string;
  /** Per-run fetcher for security-sensitive agent request tools. */
  fetcher?: Fetcher;
  /** DNS-pinned fetch for OAuth token exchange in security-sensitive agent tools. */
  oauthFetch?: typeof globalThis.fetch;
  /**
   * Run-scoped OAuth2 client_credentials token cache (one per run, shared by
   * its requests). Absent = no reuse: every request fetches its own token.
   */
  oauth2TokenCache?: OAuth2TokenCache;
  /** Run-scoped MCP sessions: initialize once per server, closed at run end. */
  mcpSessions?: CliMcpSessionPool;
  /** Explicit external-secret resolver; omitted profiles fail closed. */
  externalSecretResolver?: ExternalSecretResolver;
}

export type Executor = (req: LoadedRequest, opts: ExecuteOptions) => Promise<ExecuteOutcome>;
