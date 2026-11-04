/**
 * Backend-agnostic adapters for the two Worker features that aren't pure fetch:
 * upstream HTTP/HTTPS proxying through a CONNECT tunnel, and native WebSocket
 * termination. The Cloudflare and Node entries each supply their own
 * implementation; everything else in the Hono app reuses the same code.
 */
import type { MiddlewareHandler } from 'hono';
import type { NodeDnsGuardOptions } from './shared/dns-guard-node';
import type { UpstreamProxy } from './shared/tcp-proxy';

export interface TcpProxyAdapter {
  httpsViaConnectProxy: (
    targetUrl: URL,
    proxy: UpstreamProxy,
    requestInit: RequestInit,
    signal: AbortSignal
  ) => Promise<Response>;
  httpViaProxy: (
    targetUrl: URL,
    proxy: UpstreamProxy,
    requestInit: RequestInit,
    signal: AbortSignal
  ) => Promise<Response>;
}

// `@hono/node-ws#upgradeWebSocket` returns a MiddlewareHandler; the Cloudflare
// WebSocketPair handler is shaped as a plain handler `(c) => Response`. Both
// are accepted by Hono's `app.get()` at registration time.
// biome-ignore lint/suspicious/noExplicitAny: legacy type boundary
export type WebSocketHandler = MiddlewareHandler<any>;

export interface NodeGuardedFetchOptions extends NodeDnsGuardOptions {
  /**
   * Negotiate HTTP/2 (ALPN). gRPC reflection is a bidi-streaming RPC that
   * Connect servers only accept over h2; Node's built-in fetch is HTTP/1.1.
   */
  http2?: boolean;
}

/**
 * The self-host Node upstream fetch: SSRF-checks the target AND pins the dial
 * to the validated address(es), so a DNS rebind between check and connect
 * cannot reach an internal host (`worker/shared/guarded-fetch-node.ts`).
 * Omitted on Cloudflare, whose runtime fetch refuses private targets itself;
 * handlers then use the global `fetch`.
 */
export type NodeGuardedFetch = (
  url: string,
  init: RequestInit,
  options: NodeGuardedFetchOptions
) => Promise<Response>;

export interface AppDeps {
  tcpProxy: TcpProxyAdapter;
  websocketHandler: WebSocketHandler;
  nodeFetch?: NodeGuardedFetch;
}

/** Upstream fetch for a handler: the pinned Node fetch when injected, else the runtime's. */
export function upstreamFetch(
  nodeFetch: NodeGuardedFetch | undefined,
  url: string,
  init: RequestInit,
  options: NodeGuardedFetchOptions
): Promise<Response> {
  return nodeFetch ? nodeFetch(url, init, options) : fetch(url, init);
}
