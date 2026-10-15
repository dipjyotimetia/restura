import { isElectron } from '@/lib/shared/platform';
import { ElectronGraphQLSocket } from './electronGraphQLSocket';

/** Subprotocol of the modern graphql-ws protocol. */
export const GRAPHQL_TRANSPORT_WS_SUBPROTOCOL = 'graphql-transport-ws';
/**
 * Subprotocol of Apollo's legacy `subscriptions-transport-ws` protocol. The
 * name collision with the `graphql-ws` npm package is historical.
 */
export const LEGACY_GRAPHQL_WS_SUBPROTOCOL = 'graphql-ws';

/** What `auto` offers in Sec-WebSocket-Protocol, in preference order. */
export const AUTO_SUBPROTOCOLS = [GRAPHQL_TRANSPORT_WS_SUBPROTOCOL, LEGACY_GRAPHQL_WS_SUBPROTOCOL];

/**
 * The slice of the WebSocket interface the subscription clients use. Satisfied
 * by the browser `WebSocket` and by `ElectronGraphQLSocket` (the IPC bridge).
 */
export interface SubscriptionSocket {
  readonly protocol: string;
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export const SOCKET_OPEN = 1;

/** The payload every subscription protocol sends for an operation. */
export interface SubscriptionOperation {
  query: string;
  variables?: Record<string, unknown>;
  /** Selects the operation when the document holds several. Omitted when absent. */
  operationName?: string;
}

/** Terminal-aware callbacks shared by the hand-rolled protocol clients. */
export interface SubscriptionSink {
  /** Connection established; `protocol` is the negotiated wire protocol. */
  connected(protocol: string): void;
  next(value: unknown): void;
  /** Terminal failure (transport or operation). */
  error(err: unknown): void;
  complete(): void;
}

/** Operation payload with `operationName` only when set (servers reject `null` in some cases). */
export function operationPayload(op: SubscriptionOperation): Record<string, unknown> {
  return {
    query: op.query,
    ...(op.variables !== undefined ? { variables: op.variables } : {}),
    ...(op.operationName ? { operationName: op.operationName } : {}),
  };
}

/** http(s) → ws(s); ws(s) URLs pass through. */
export function toWebSocketUrl(url: string): string {
  return url.replace(/^http:\/\//, 'ws://').replace(/^https:\/\//, 'wss://');
}

/** ws(s) → http(s); http(s) URLs pass through. Used by graphql-sse. */
export function toHttpUrl(url: string): string {
  return url.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://');
}

/**
 * Open a WebSocket offering `protocols`. Desktop tunnels over the WS IPC bridge
 * (renderer-direct ws: is CSP-blocked) and sends `headers` on the handshake;
 * the browser API cannot set handshake headers, so web callers carry
 * credentials in the protocol's connection payload instead.
 */
export function openSubscriptionSocket(
  url: string,
  protocols: string[],
  headers: Record<string, string>
): SubscriptionSocket {
  if (isElectron()) return new ElectronGraphQLSocket(url, protocols, headers);
  return new WebSocket(url, protocols) as unknown as SubscriptionSocket;
}

/** Human-readable message for an error value from any protocol client. */
export function describeSubscriptionError(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (Array.isArray(err)) {
    const parts = err.map((e) => describeSubscriptionError(e, String(e)));
    return parts.length > 0 ? parts.join(', ') : fallback;
  }
  if (err && typeof err === 'object') {
    const o = err as { message?: unknown; reason?: unknown; code?: unknown };
    if (typeof o.message === 'string' && o.message) return o.message;
    if (typeof o.reason === 'string' && o.reason) return o.reason;
    if (typeof o.code === 'number') return `Connection closed (${o.code})`;
  }
  if (typeof err === 'string' && err) return err;
  return fallback;
}
