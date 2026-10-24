import type { SecretValue } from '../secrets/secret-ref';
import type { AuthConfig } from './auth';
import type { KeyValue } from './common';
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

/**
 * `stdio` is desktop-only: the Electron main process spawns the configured
 * command (no shell) after an explicit, main-owned consent prompt. Web and
 * the CLI refuse it. See docs/adr/0030-mcp-stdio-transport.md.
 */
export type McpTransportType = 'streamable-http' | 'http-sse' | 'stdio';

/**
 * One environment variable handed to a stdio MCP server. Mirrors the scoped
 * variable shape: `value` is the editable plaintext; when `secretRef` is set
 * (e.g. a `{ kind: 'handle' }` SecretRef from an mcp.json import) it wins and
 * is resolved in the main process at spawn time, never in the renderer.
 */
export interface McpStdioEnvVar extends KeyValue {
  secretRef?: SecretValue;
}

/** Launch configuration for a local stdio MCP server (desktop only). */
export interface McpStdioConfig {
  /** Executable — a bare name resolved via PATH, or an absolute path. */
  command: string;
  /** Arguments passed verbatim (argv); never parsed by a shell. */
  args: string[];
  /** Absolute working directory; defaults to the user's home directory. */
  cwd?: string;
  /** Extra environment variables. The child never inherits the app's env. */
  env?: McpStdioEnvVar[];
}

export interface McpRequest {
  id: string;
  name: string;
  type: 'mcp';
  url: string;
  transport: McpTransportType;
  /** Launch config, used only when `transport === 'stdio'` (url is ignored). */
  stdio?: McpStdioConfig;
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
  /** Human-readable display name (`title`, falling back to `annotations.title`) */
  title?: string;
  description?: string;
  /** JSON Schema for the tool's input arguments */
  inputSchema?: McpJsonSchema;
  /** JSON Schema `structuredContent` is expected to satisfy (MCP 2025-06-18) */
  outputSchema?: McpJsonSchema;
  /** Behavioural hints — untrusted when the server is untrusted */
  annotations?: McpToolAnnotations;
}

/** Tool behaviour hints (MCP 2025-06-18 `ToolAnnotations`). Hints only. */
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpResourceDescriptor {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** A parameterised resource advertised via `resources/templates/list` (RFC 6570 URI template). */
export interface McpResourceTemplateDescriptor {
  uriTemplate: string;
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
  allOf?: McpJsonSchema[];
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
    completions?: Record<string, unknown>;
  };
  tools: McpToolDescriptor[];
  resources: McpResourceDescriptor[];
  /** From `resources/templates/list`; absent when the server has no resources capability. */
  resourceTemplates?: McpResourceTemplateDescriptor[];
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
