import type { ComponentType } from 'react';
import type { Request, Response, RequestType, ScriptResult } from '@/types';

/**
 * Protocols the registry knows about. Superset of `RequestType` because
 * GraphQL re-uses the `HttpRequest` shape and WebSocket/Kafka are
 * connection-based (no per-request `Request` discriminator). The runtime
 * registry only uses this for diagnostics / metadata, so widening it here
 * doesn't pollute the narrower `Request` union used by stores and selectors.
 */
export type ProtocolTabType = RequestType | 'graphql' | 'websocket' | 'kafka' | 'mqtt' | 'socketio';

export interface ProtocolScriptResult {
  preRequest?: ScriptResult;
  test?: ScriptResult;
}

export interface RunContext {
  signal: AbortSignal;
  variables: Record<string, string>;
  /**
   * Optional sink for pre-request / test script results produced by the
   * protocol. Protocols that run user scripts call this once per run so the
   * caller (typically `useRequestRunner`) can forward results to the
   * Console panel via `useRequestStore.setScriptResult`. Protocols without
   * a script pipeline may omit the call entirely.
   */
  onScriptResult?: (result: ProtocolScriptResult) => void;
  /**
   * Per-protocol options that don't fit on the `Request` shape itself —
   * e.g. gRPC's transient proto content, or future cert overrides. Each
   * protocol defines its own keys; cross-protocol callers ignore unknown
   * entries. Intentionally untyped (`unknown`) so additions don't ripple
   * through the registry — the protocol module narrows internally.
   */
  protocolOptions?: Record<string, unknown>;
}

export interface ProtocolModule {
  /** Stable id used in URLs, code generators, analytics */
  id: string;
  /** Display label in mode picker */
  label: string;
  /** Which `Request` discriminator this protocol uses (or 'graphql'/'websocket' for non-Request protocols) */
  tabType: ProtocolTabType;
  /** React component rendered as the request builder (registered later) */
  Builder?: ComponentType<{ request: Request; onChange: (next: Request) => void }>;
  /** Construct a default empty Request for this protocol */
  defaultRequest: () => Request;
  /** Execute the request and resolve to a Response (or throw) */
  runRequest: (request: Request, ctx: RunContext) => Promise<Response>;
  /** Optional: code-generator entries this protocol contributes */
  codeGenerators?: Record<string, (request: Request) => string>;
  /**
   * Substitute `{{var}}` references in the request shape. Per-protocol
   * because each protocol's request has different stringy fields (HTTP:
   * url, headers, params, body.raw; gRPC: url, metadata, message;
   * GraphQL: HTTP-shaped but `body.raw` is a structured JSON envelope).
   *
   * Pure — does not mutate the input. The DAG executor and the legacy
   * linear workflow executor call this BEFORE `runRequest` so the wire
   * bytes reflect the resolved variables and auth signing (which runs at
   * the wire) sees the final form.
   *
   * Optional: protocols that don't need pre-call substitution (e.g.
   * session-based MCP/SSE, which aren't invoked through the executor)
   * may omit it. The executor falls back to the identity function in
   * that case and logs a one-time warning to surface the gap.
   */
  injectVariables?: (request: Request, variables: Record<string, string>) => Request;
  /**
   * Open a long-lived streaming connection. Only defined on protocols
   * whose `runRequest` doesn't apply — SSE (server-push), WebSocket
   * (full-duplex). The DAG executor's streaming-node executors
   * (`sseSubscribe`, `wsExchange`) call this; legacy paths never do.
   *
   * `request` is `unknown` because not every streaming protocol's
   * input shape fits the `Request` discriminated union — WebSocket
   * has no `Request` variant and is invoked with an inline `{ type:
   * 'websocket', url }` shape. Each implementer narrows internally
   * (`if (req.type !== 'sse') throw ...`). Mirrors the precedent set
   * by `RunContext.protocolOptions: Record<string, unknown>`.
   *
   * MCP is session-based JSON-RPC; it uses `runJsonRpc` (defined on
   * the MCP module specifically) rather than `startStream`.
   */
  startStream?: (request: unknown, ctx: RunContext) => Promise<ProtocolStreamHandle>;
}

/**
 * Handle to a streaming protocol connection. Returned by
 * `ProtocolModule.startStream`. The executor iterates `events` until
 * a completion policy fires, then calls `close()`. `ctx.signal` aborts
 * both halves; the protocol implementation must honour it.
 */
export interface ProtocolStreamHandle {
  /**
   * Async iterable of typed events. The protocol module owns the event
   * shape (SSE: `ParsedSseEvent`; WebSocket: raw frame data). The
   * iterable ends when the server closes the stream, `close()` is
   * called, or `ctx.signal` aborts.
   */
  events: AsyncIterable<unknown>;
  /** Force the stream to close. Idempotent. Best-effort — server-side
   *  closes may already be in flight when this is called. */
  close: () => Promise<void>;
}

export interface ProtocolRegistry {
  register(module: ProtocolModule): void;
  get(id: string): ProtocolModule | undefined;
  list(): ProtocolModule[];
}
