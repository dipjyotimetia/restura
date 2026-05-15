import type { ComponentType } from 'react';
import type { Request, Response, RequestType, ScriptResult } from '@/types';

/**
 * Protocols the registry knows about. Superset of `RequestType` because
 * GraphQL re-uses the `HttpRequest` shape and WebSocket/Kafka are
 * connection-based (no per-request `Request` discriminator). The runtime
 * registry only uses this for diagnostics / metadata, so widening it here
 * doesn't pollute the narrower `Request` union used by stores and selectors.
 */
export type ProtocolTabType = RequestType | 'graphql' | 'websocket' | 'kafka';

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
}

export interface ProtocolRegistry {
  register(module: ProtocolModule): void;
  get(id: string): ProtocolModule | undefined;
  list(): ProtocolModule[];
}
