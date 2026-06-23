import type { KeyValue } from './common';
import type { AuthConfig } from './auth';
import type { Response } from './http';

// SSE (Server-Sent Events) Request
export interface SseRequest {
  id: string;
  name: string;
  type: 'sse';
  url: string;
  headers: KeyValue[];
  params: KeyValue[];
  auth: AuthConfig;
  /** Optional client-side filter (event names) — purely UI-side */
  eventFilter?: string[];
  /** Whether to reconnect using Last-Event-ID on disconnect */
  reconnectOnResume?: boolean;
  preRequestScript?: string;
  testScript?: string;
}

// SSE event payload, as parsed from the wire format (app-level shape; distinct
// from the raw `SseEvent` in @shared/protocol/sse-parser and the
// `SseEventRecord` UI row in features/sse/store).
export interface SseEventPayload {
  id: string;
  /** Server-supplied event name; defaults to "message" per the SSE spec */
  event: string;
  /** Concatenated `data:` lines (LF-joined) */
  data: string;
  /** Server-supplied event id, if any */
  lastEventId?: string;
  /** Server-supplied retry hint in ms, if any */
  retry?: number;
  timestamp: number;
}

// MCP (Model Context Protocol) types

export type McpTransportType = 'streamable-http' | 'http-sse';

export interface McpRequest {
  id: string;
  name: string;
  type: 'mcp';
  url: string;
  transport: McpTransportType;
  headers: KeyValue[];
  auth: AuthConfig;
  /** Optional default JSON-RPC method to invoke when "Send" is pressed */
  defaultMethod?: string;
  /** Optional default params for the default method */
  defaultParams?: string;
  preRequestScript?: string;
  testScript?: string;
}

/** A single tool/resource/prompt descriptor returned by the server */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  /** JSON Schema for the tool's input arguments */
  inputSchema?: McpJsonSchema;
}

export interface McpResourceDescriptor {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptDescriptor {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

/** Subset of JSON Schema Restura cares about for template generation */
export interface McpJsonSchema {
  type?: string | string[];
  properties?: Record<string, McpJsonSchema>;
  items?: McpJsonSchema | McpJsonSchema[];
  required?: string[];
  enum?: unknown[];
  default?: unknown;
  description?: string;
  format?: string;
  $ref?: string;
  oneOf?: McpJsonSchema[];
  anyOf?: McpJsonSchema[];
  additionalProperties?: boolean | McpJsonSchema;
}

export interface McpServerCapabilities {
  serverName?: string;
  serverVersion?: string;
  protocolVersion?: string;
  /** Capabilities advertised by the server in `initialize` */
  capabilities?: {
    tools?: { listChanged?: boolean };
    resources?: { listChanged?: boolean; subscribe?: boolean };
    prompts?: { listChanged?: boolean };
    logging?: Record<string, unknown>;
  };
  tools: McpToolDescriptor[];
  resources: McpResourceDescriptor[];
  prompts: McpPromptDescriptor[];
}

/** Result of a single JSON-RPC call */
export interface McpResponse extends Response {
  /** The raw JSON-RPC `result` field (parsed) */
  result?: unknown;
  /** The raw JSON-RPC `error` field (parsed) */
  jsonRpcError?: { code: number; message: string; data?: unknown };
  /** Echoed JSON-RPC method for display */
  method?: string;
}

/**
 * Stream event union for HTTP streaming responses (SSE / NDJSON / raw).
 *
 * Defined here (rather than imported from
 * `@/features/http/lib/streamingResponseReader`) so that `src/types`
 * remains a leaf module — importing from features into types creates a
 * dependency cycle since features re-export types from here.
 *
 * The shape must remain assignment-compatible with `HttpStreamEvent` in
 * `streamingResponseReader.ts` (which uses the raw `SseEvent` from
 * `shared/protocol/sse-parser` for the SSE payload).
 */
export type StreamEventLike =
  | { type: 'sse'; payload: { id?: string; event?: string; data: string; retry?: number } }
  | { type: 'ndjson'; payload: unknown }
  | { type: 'raw'; payload: string }
  | { type: 'end'; bytesRead: number; durationMs: number }
  | { type: 'error'; error: string; bytesRead: number };
