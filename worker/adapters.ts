/**
 * Backend-agnostic adapters for the two Worker features that aren't pure fetch:
 * upstream HTTP/HTTPS proxying through a CONNECT tunnel, and native WebSocket
 * termination. The Cloudflare and Node entries each supply their own
 * implementation; everything else in the Hono app reuses the same code.
 */
import type { MiddlewareHandler } from 'hono';
import type { UpstreamProxy } from './shared/tcp-proxy';
import type { NodeDnsGuardOptions } from './shared/dns-guard-node';

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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WebSocketHandler = MiddlewareHandler<any>;

export type NodeHostnameGuard = (
  hostname: string,
  options: NodeDnsGuardOptions
) => Promise<unknown>;

export interface AppDeps {
  tcpProxy: TcpProxyAdapter;
  websocketHandler: WebSocketHandler;
  nodeHostnameGuard?: NodeHostnameGuard;
}
