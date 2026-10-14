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

export type NodeHostnameGuard = (
  hostname: string,
  options: NodeDnsGuardOptions
) => Promise<unknown>;

export interface AppDeps {
  tcpProxy: TcpProxyAdapter;
  websocketHandler: WebSocketHandler;
  nodeHostnameGuard?: NodeHostnameGuard;
  /**
   * Fetch for the gRPC reflection upstream hop. Reflection is a bidi-streaming
   * RPC that Connect servers only accept over HTTP/2; Node's built-in fetch
   * speaks HTTP/1.1, so the Node entry supplies an undici `allowH2` fetch.
   * Omitted on Cloudflare (runtime fetch).
   */
  grpcReflectionFetch?: (input: string, init: RequestInit) => Promise<Response>;
}
