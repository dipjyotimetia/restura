import type { SecretValue } from '@/lib/shared/secretRef';
import type { Provider } from '@shared/protocol/ai/types';
// gRPC status codes — single source of truth in the shared protocol core.
import { GrpcStatusCode, GrpcStatusCodeName } from '@shared/protocol/grpc-status';

// HTTP Methods
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS' | 'HEAD';

// gRPC Methods
export type GrpcMethodType =
  | 'unary'
  | 'server-streaming'
  | 'client-streaming'
  | 'bidirectional-streaming';

// gRPC Status Codes — re-exported from @shared/protocol/grpc-status (the single
// source of truth shared with the Worker/Electron gRPC proxy). Two separate enum
// declarations would be nominally distinct types, so this must not be redefined.
export { GrpcStatusCode, GrpcStatusCodeName };

// Request Types
export type RequestType = 'http' | 'grpc' | 'sse' | 'mcp';

// Request Mode (used for UI mode switching)
// Kafka and MQTT are connection-based (no Request shape) and Electron-only —
// the picker still surfaces them in the web build but the page renders a
// "Desktop only" panel.
export type RequestMode =
  | 'http'
  | 'grpc'
  | 'websocket'
  | 'graphql'
  | 'sse'
  | 'mcp'
  | 'kafka'
  | 'mqtt'
  | 'socketio';

// Body Types
export type BodyType =
  | 'none'
  | 'json'
  | 'xml'
  | 'form-data'
  | 'x-www-form-urlencoded'
  | 'binary'
  | 'protobuf'
  | 'graphql'
  | 'text'
  | 'multipart-mixed';

// Multipart Mixed Part
export interface MultipartPart {
  id: string;
  contentType: string;
  content: string;
  headers?: Record<string, string>;
}

// Request Body Type (extracted for reusability)
export interface RequestBody {
  type: BodyType;
  raw?: string;
  formData?: FormDataItem[];
  binary?: File;
  multipartParts?: MultipartPart[];
}

// Authentication Types
export type AuthType =
  | 'none'
  | 'basic'
  | 'bearer'
  | 'api-key'
  | 'oauth2'
  | 'digest'
  | 'aws-signature'
  | 'oauth1'
  | 'ntlm'
  | 'wsse';

// Key-Value Pair
export interface KeyValue {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
  description?: string;
  secret?: boolean;
}

// Form Data
export interface FormDataItem extends KeyValue {
  type: 'text' | 'file';
  // For `type: 'file'`, the picked file's base64-encoded bytes live in `value`;
  // these carry the multipart filename + MIME so the built wire body is correct.
  fileName?: string;
  contentType?: string;
}

// Authentication Configuration
// Sensitive credential fields use `SecretValue` (string | SecretRef) per ADR-0007.
// Inline shapes mirror legacy plaintext; handle shapes are desktop-only and
// resolved main-process-side at the wire boundary.
export interface AuthConfig {
  type: AuthType;
  basic?: {
    username: string;
    password: SecretValue;
  };
  bearer?: {
    token: SecretValue;
  };
  apiKey?: {
    key: string;
    value: SecretValue;
    in: 'header' | 'query';
  };
  oauth2?: {
    accessToken: SecretValue;
    tokenType?: string;
    refreshToken?: SecretValue;
    expiresAt?: number;
    scopes?: string[];
    // Flow configuration
    grantType?: 'authorization_code' | 'client_credentials' | 'password' | 'device_code';
    clientId?: string;
    clientSecret?: SecretValue;
    authorizationUrl?: string;
    tokenUrl?: string;
    /** RFC 8628 device authorization endpoint — required for device_code grant */
    deviceAuthorizationUrl?: string;
    scope?: string;
    redirectUri?: string;
    // Password grant only
    username?: string;
    password?: SecretValue;
  };
  digest?: {
    username: string;
    password: SecretValue;
  };
  awsSignature?: {
    accessKey: string;
    secretKey: SecretValue;
    region: string;
    service: string;
  };
  oauth1?: {
    consumerKey: string;
    consumerSecret: SecretValue;
    accessToken?: SecretValue;
    accessTokenSecret?: SecretValue;
    /** Default HMAC-SHA1 if omitted. */
    signatureMethod?: 'HMAC-SHA1' | 'HMAC-SHA256' | 'PLAINTEXT';
    realm?: string;
    /** If set, used as-is. Otherwise generated per request. */
    nonce?: string;
    /** Unix seconds. If set, used as-is. Otherwise generated per request. */
    timestamp?: string;
    /** Add to body params for form-encoded POSTs (RFC 5849 §3.4.1.3.1). */
    addParamsToBody?: boolean;
  };
  /** NTLM is desktop-only (Electron). The browser/Worker emit a warning at request time. */
  ntlm?: {
    username: string;
    password: SecretValue;
    domain?: string;
    workstation?: string;
  };
  wsse?: {
    username: string;
    password: SecretValue;
    /** PasswordDigest = sha1(nonce + created + password) base64. PasswordText sends the password verbatim (avoid). */
    passwordType?: 'PasswordDigest' | 'PasswordText';
  };
}

// HTTP Request
export interface HttpRequest {
  id: string;
  name: string;
  type: 'http';
  method: HttpMethod;
  url: string;
  headers: KeyValue[];
  params: KeyValue[];
  body: RequestBody;
  auth: AuthConfig;
  preRequestScript?: string;
  testScript?: string;
  settings?: RequestSettings;
  /**
   * Optional link from this request to an OpenAPI operation. Lets the
   * contracts feature validate response shape at execution time. The
   * `operationId` matches an `operationId` in the spec attached at
   * collection/folder level via `Collection.contractSpec`.
   */
  contractRef?: {
    operationId: string;
  };
}

// gRPC Request
export interface GrpcRequest {
  id: string;
  name: string;
  type: 'grpc';
  methodType: GrpcMethodType;
  url: string;
  service: string;
  method: string;
  metadata: KeyValue[];
  message: string;
  auth: AuthConfig;
  preRequestScript?: string;
  testScript?: string;
}

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

// Union type for any request
export type Request = HttpRequest | GrpcRequest | SseRequest | McpRequest;

/**
 * Stream event union for HTTP streaming responses (SSE / NDJSON / raw).
 *
 * Defined inline here (rather than imported from
 * `@/features/http/lib/streamingResponseReader`) so that `src/types`
 * remains a leaf module — importing from features into types creates a
 * dependency cycle since features re-export types from here.
 *
 * The shape must remain assignment-compatible with `StreamEvent` in
 * `streamingResponseReader.ts` (which uses the raw `SseEvent` from
 * `shared/protocol/sse-parser` for the SSE payload).
 */
export type StreamEventLike =
  | { type: 'sse'; payload: { id?: string; event?: string; data: string; retry?: number } }
  | { type: 'ndjson'; payload: unknown }
  | { type: 'raw'; payload: string }
  | { type: 'end'; bytesRead: number; durationMs: number }
  | { type: 'error'; error: string; bytesRead: number };

// Multi-tab request tab
/**
 * Workspace modes that don't have a dedicated RequestType. They layer on top of
 * an HTTP placeholder tab via `RequestTab.modeOverride`; the actual connection
 * state lives in the per-protocol stores (`useWebSocketStore`, etc.).
 *
 * Derived from the existing unions so adding a future mode to `RequestMode`
 * without a corresponding `RequestType` propagates automatically.
 */
export type TabModeOverride = Exclude<RequestMode, RequestType>;

/**
 * Runtime companion to {@link TabModeOverride}. The `Record` makes the set of
 * connection-based modes exhaustive at compile time — adding a new
 * `TabModeOverride` without listing it here is a type error, so the UI call
 * sites that branch on "is this a connection-based mode?" can never silently
 * fall out of sync (the failure mode that previously shipped a protocol
 * missing from one of several hand-maintained `||` lists).
 */
const CONNECTION_MODES: Record<TabModeOverride, true> = {
  graphql: true,
  websocket: true,
  socketio: true,
  kafka: true,
  mqtt: true,
};

/** True when `mode` opens via `openTabWithMode` (a `modeOverride` tab) rather than a real `RequestType`. */
export function isConnectionMode(mode: string): mode is TabModeOverride {
  return mode in CONNECTION_MODES;
}

export interface RequestTab {
  id: string;
  request: Request;
  /** Last response received in this tab; persists across reloads. */
  response?: Response | null;
  /** Last script results (pre-request + test) for this tab's request. */
  scriptResult?: { preRequest?: ScriptResult; test?: ScriptResult } | null;
  /** Whether the request has unsaved changes vs the saved version (savedRequestId). */
  isDirty: boolean;
  /** If this tab was opened from a saved request in a collection, the saved request's id. */
  savedRequestId?: string;
  /**
   * Pseudo-mode marker. Present when the tab represents a WebSocket / Socket.IO
   * / Kafka / GraphQL session (none of which have their own RequestType). The
   * underlying `request` is an HTTP scaffold acting as a placeholder.
   */
  modeOverride?: TabModeOverride;
  /**
   * In-flight or recently completed streaming response. NOT persisted —
   * AsyncIterables aren't JSON-serializable and streams are inherently
   * transient. Stripped by `partialize` in `useRequestStore`.
   */
  streamingEvents?: AsyncIterable<StreamEventLike>;
}

// Response
export interface Response {
  id: string;
  requestId: string;
  status: number;
  statusText: string;
  headers: Record<string, string | string[]>;
  body: string;
  size: number;
  time: number;
  timestamp: number;
  /**
   * How `body` is encoded. Absent means `body` is response text as-is.
   * 'base64' means the upstream returned a binary content type and `body` holds
   * the base64 of the raw bytes (decode before use, e.g. for image preview).
   */
  bodyEncoding?: 'base64';
  /**
   * Negotiated ALPN protocol when known. Populated by Electron's undici fetcher;
   * absent for the worker path (CF runtime doesn't expose ALPN).
   */
  negotiatedAlpn?: 'h1.1' | 'h2' | 'h3';
}

// gRPC Response (specialized for gRPC)
export interface GrpcResponse extends Response {
  grpcStatus?: GrpcStatusCode;
  grpcStatusText?: string;
  trailers?: Record<string, string>;
  messages?: string[]; // For streaming responses, each message as JSON string
  isStreaming?: boolean;
}

// Proto File Definition (parsed)
export interface ProtoServiceDefinition {
  name: string;
  fullName: string; // e.g., "greet.v1.GreetService"
  methods: ProtoMethodDefinition[];
}

export interface ProtoMethodDefinition {
  name: string;
  inputType: string;
  outputType: string;
  clientStreaming: boolean;
  serverStreaming: boolean;
}

export interface ProtoFileInfo {
  fileName: string;
  package: string;
  services: ProtoServiceDefinition[];
  messages: Record<string, ProtoMessageDefinition>;
}

export interface ProtoMessageDefinition {
  name: string;
  fields: ProtoFieldDefinition[];
}

export interface ProtoFieldDefinition {
  name: string;
  type: string;
  number: number;
  repeated: boolean;
  optional: boolean;
}

// gRPC Reflection Types
export interface ReflectionServiceInfo {
  name: string;
  fullName: string;
  methods: ReflectionMethodInfo[];
  /**
   * Base64 binary FileDescriptorProtos (the file containing this service plus
   * its transitive imports) as returned by reflection. Threaded to the Electron
   * gRPC call so it loads the complete descriptor set via proto-loader instead
   * of lossy reconstructed `.proto` text. Electron-only — undefined on web.
   */
  descriptors?: string[];
}

export interface ReflectionMethodInfo {
  name: string;
  fullName: string;
  inputType: string;
  outputType: string;
  clientStreaming: boolean;
  serverStreaming: boolean;
  inputMessageSchema: MessageSchema;
  outputMessageSchema: MessageSchema;
}

export interface MessageSchema {
  name: string;
  fullName: string;
  fields: FieldSchema[];
}

export interface FieldSchema {
  name: string;
  jsonName: string;
  number: number;
  type: FieldType;
  typeName?: string; // For message/enum types
  label: FieldLabel;
  defaultValue?: unknown;
  oneofIndex?: number;
  mapKey?: FieldSchema;
  mapValue?: FieldSchema;
}

export type FieldType =
  | 'TYPE_DOUBLE'
  | 'TYPE_FLOAT'
  | 'TYPE_INT64'
  | 'TYPE_UINT64'
  | 'TYPE_INT32'
  | 'TYPE_FIXED64'
  | 'TYPE_FIXED32'
  | 'TYPE_BOOL'
  | 'TYPE_STRING'
  | 'TYPE_GROUP'
  | 'TYPE_MESSAGE'
  | 'TYPE_BYTES'
  | 'TYPE_UINT32'
  | 'TYPE_ENUM'
  | 'TYPE_SFIXED32'
  | 'TYPE_SFIXED64'
  | 'TYPE_SINT32'
  | 'TYPE_SINT64';

export type FieldLabel = 'LABEL_OPTIONAL' | 'LABEL_REQUIRED' | 'LABEL_REPEATED';

export interface ReflectionResult {
  success: boolean;
  services: ReflectionServiceInfo[];
  error?: string;
  serverUrl: string;
  timestamp: number;
}

export interface EnumSchema {
  name: string;
  fullName: string;
  values: EnumValue[];
}

export interface EnumValue {
  name: string;
  number: number;
}

// Environment
export interface Environment {
  id: string;
  name: string;
  variables: KeyValue[];
}

// Collection Item
export interface CollectionItem {
  id: string;
  name: string;
  type: 'folder' | 'request';
  request?: Request;
  items?: CollectionItem[];
  /**
   * Folder-level default auth (only meaningful when type === 'folder').
   * Descendant requests whose own auth is 'none' inherit the nearest
   * ancestor folder's auth, falling back to the collection-level auth —
   * mirroring Postman's folder-auth semantics.
   */
  auth?: AuthConfig;
  /**
   * Optional contract spec attached at folder scope (only meaningful when
   * type === 'folder'). Overrides the collection-level spec for any
   * descendant requests.
   */
  contractSpec?: ContractSpecSource;
  /**
   * Folder-level pre-request / test scripts (only meaningful when
   * type === 'folder'). In a collection run they execute for every descendant
   * request, after the collection-level script and before the request's own,
   * mirroring Postman's parent-to-child execution order. Stored in the native
   * `rs.*` namespace (Postman `pm.*` is migrated on import).
   */
  preRequestScript?: string;
  testScript?: string;
}

/**
 * Source location for an OpenAPI / Swagger contract spec attached to a
 * collection or folder. The spec text itself isn't persisted in the
 * Zustand store (parsed specs can be large) — only the source pointer.
 * The contracts feature loads + parses on demand and caches in memory.
 */
export interface ContractSpecSource {
  /** OpenAPI 3.0/3.1 (default) or AsyncAPI 2.x/3.x (future). */
  kind?: 'openapi' | 'asyncapi';
  source: 'url' | 'inline' | 'file';
  /** Present when source === 'url'. */
  url?: string;
  /** Present when source === 'inline'. YAML or JSON. */
  inline?: string;
  /** Present when source === 'file' (desktop only). Absolute path. */
  filePath?: string;
}

// Collection
export interface Collection {
  id: string;
  name: string;
  description?: string;
  items: CollectionItem[];
  auth?: AuthConfig;
  variables?: KeyValue[];
  /**
   * Optional OpenAPI spec attached at collection scope. Requests with a
   * `contractRef` are validated against this spec at execution time.
   * Folders can override via their own `contractSpec` on `CollectionItem`.
   */
  contractSpec?: ContractSpecSource;
  /**
   * Collection-level pre-request / test scripts. In a collection run they
   * execute for every request: first in the parent-to-child chain
   * (collection -> folder -> request). Stored in the native `rs.*` namespace
   * (Postman `pm.*` is migrated on import).
   */
  preRequestScript?: string;
  testScript?: string;
}

// History Item
export interface HistoryItem {
  id: string;
  request: Request;
  response?: Response;
  timestamp: number;
}

/**
 * A single route served by the desktop mock server (record-and-replay). Built
 * from a collection + history by `buildMockRoutes`, then sent over IPC to
 * `electron/main/handlers/mock-server-handler.ts`. Mock is desktop-only (see
 * capabilities `mock.localServer`) — web can't bind a local listener.
 */
export type { MockRoute, MockServerStatus } from '@shared/mock-types';

// Script Execution Result
export interface ScriptResult {
  success: boolean;
  logs: Array<{ type: 'log' | 'error' | 'warn' | 'info'; message: string; timestamp: number }>;
  errors: string[];
  variables: Record<string, string>;
  tests?: Array<{ name: string; passed: boolean; error?: string }>;
  /** `pm.globals.set/unset` mutations the script applied (Phase A). */
  globalsMutations?: Record<string, string | null>;
  /** `pm.collectionVariables.set/unset` mutations (Phase A). */
  collectionMutations?: Record<string, string | null>;
  /** Runner flow control from `pm.execution.setNextRequest / skipRequest` (Phase A/C). */
  execution?: {
    nextRequest?: string | null;
    skipRequested?: boolean;
  };
  /** `pm.visualizer.set(template, data)` payload (Phase D). */
  visualization?: {
    template: string;
    data: unknown;
  };
}

// Certificate Configuration
export interface ClientCert {
  format: 'pfx' | 'pem';
  pfx?: string; // base64-encoded .p12/.pfx content
  cert?: string; // PEM certificate string
  key?: string; // PEM private key string (encrypted at rest)
  // SecretValue per ADR-0007: plain string (legacy/inline) or a keychain
  // handle resolved in the Electron main process at wire-signing time.
  passphrase?: SecretValue;
}

export interface CaCert {
  pem: string; // PEM-encoded CA certificate chain
}

// Per-domain certificate entries (Postman / Insomnia parity). Each is scoped
// to a host pattern (`api.example.com`, `*.example.com`, `.example.com`) with
// an optional port. Selection is most-specific-wins; see
// `src/lib/shared/certMatcher.ts`. Desktop-only (mTLS / custom CA need
// Node TLS — the web build never applies these).
export interface HostClientCert {
  /** Stable id for list editing. */
  id: string;
  /** Host pattern. Exact, `*.sub` wildcard, or `.suffix`. */
  host: string;
  /** Optional port qualifier. Unset = any port. */
  port?: number;
  /** The mTLS client certificate material applied for matching requests. */
  cert: ClientCert;
}

export interface HostCaCert {
  id: string;
  host: string;
  port?: number;
  /** PEM-encoded CA certificate chain trusted for matching requests. */
  pem: string;
}

// Proxy Configuration
export type ProxyType = 'none' | 'http' | 'https' | 'socks4' | 'socks5';

export interface ProxyConfig {
  enabled: boolean;
  type: ProxyType;
  host: string;
  port: number;
  auth?: {
    username: string;
    // SecretValue per ADR-0007: plain string (legacy/inline) or a keychain
    // handle resolved in the Electron main process at wire-signing time.
    password: SecretValue;
  };
  bypassList?: string[]; // List of hosts to bypass proxy
}

// Request Settings (per-request configuration)
/**
 * Minimum TLS protocol floor (single value, not a multi-select).
 * Maps directly to Node's `tls.connect` `minVersion` option. Disabling
 * non-contiguous protocol versions (e.g. allow 1.0 + 1.2 but block 1.1) is
 * not expressible cleanly via Node's API — a single floor covers ~95% of
 * real-world need (enforce a minimum). Desktop-only (Electron).
 */
export type MinTlsVersion = 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';

export interface RequestSettings {
  timeout: number; // in milliseconds
  followRedirects: boolean;
  maxRedirects: number;
  verifySsl: boolean;
  proxy?: ProxyConfig;
  clientCert?: ClientCert;
  caCert?: CaCert;

  // --- redirect policy (cross-platform; honoured by shared/protocol/redirect-follower) ---
  /** If true, 301/302 redirects preserve the original method (RFC-compliant). Default: false (legacy: downgrade non-HEAD to GET). */
  followOriginalMethod?: boolean;
  /** If true, the Authorization header is preserved on cross-origin redirects. Default: false (stripped). */
  followAuthHeader?: boolean;
  /** If true, the Referer header is removed on every redirect hop. Default: false (preserved unless cross-origin policy strips it). */
  stripReferer?: boolean;

  // --- URL handling (cross-platform) ---
  /** If true (default behaviour), percent-encode path/query via WHATWG URL. If false, emit raw bytes — useful for upstreams that reject %-encoding. */
  encodeUrlAutomatically?: boolean;

  // --- Cookies (renderer-side; cross-platform) ---
  /** If true, skip cookie-jar read/write for this request. Default: false. */
  disableCookieJar?: boolean;

  // --- TLS knobs (desktop-only; honoured by Electron undici / tls.connect) ---
  /** If true, the server's cipher-suite order takes precedence (TLS honorCipherOrder). */
  serverCipherOrder?: boolean;
  /** Lower bound for TLS protocol. Omit to use Node's default. */
  minTlsVersion?: MinTlsVersion;
  /** OpenSSL-format cipher list, e.g. "ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384". */
  cipherSuites?: string;
}

// CORS Proxy Configuration (for browser mode)
export interface CorsProxyConfig {
  enabled: boolean;
  autoDetect: boolean; // Auto-enable when CORS error detected
}

// Global Application Settings
export interface AppSettings {
  proxy: ProxyConfig;
  defaultTimeout: number;
  followRedirects: boolean;
  maxRedirects: number;
  verifySsl: boolean;
  autoSaveHistory: boolean;
  maxHistoryItems: number;
  theme: 'light' | 'dark' | 'system';
  // Layout settings
  layoutOrientation: 'vertical' | 'horizontal';
  // Security settings
  allowLocalhost?: boolean;
  allowPrivateIPs?: boolean;
  // CORS proxy settings (web-only)
  corsProxy: CorsProxyConfig;
  // Certificate settings (global — applied to every HTTPS request)
  clientCert?: ClientCert;
  caCert?: CaCert;
  // Per-domain certificates (desktop-only). Matched most-specific-first by
  // `certMatcher.selectCertForUrl`; a match takes precedence over the global
  // clientCert/caCert above for that host.
  clientCertificates?: HostClientCert[];
  caCertificates?: HostCaCert[];
  // Redirect policy defaults — mirrors RequestSettings; per-request settings still override these.
  followOriginalMethod?: boolean;
  followAuthHeader?: boolean;
  stripReferer?: boolean;
  // URL & cookie defaults
  encodeUrlAutomatically?: boolean;
  disableCookieJar?: boolean;
  // TLS defaults (desktop-only enforcement)
  serverCipherOrder?: boolean;
  minTlsVersion?: MinTlsVersion;
  cipherSuites?: string;
  // Telemetry (Gap #2c). Defaults to ON (opt-out). Gates the renderer→Worker
  // error sink (web) and, on desktop, Sentry crash/error reporting (native
  // minidumps + main/renderer JS errors) — never request payloads, headers, or
  // response bodies. The flag is mirrored to the Electron main process so it can
  // gate Sentry; see electron/main/lifecycle/sentry.ts and electron/main/lifecycle/telemetry-consent.ts.
  telemetry?: {
    errorsEnabled: boolean;
  };
  // Spatial Depth accent preset; drives --sp-accent CSS variable
  accent?: SpatialAccent;
  // Desktop auto-updater preferences (Electron only). Synced to the main
  // process via window.electron.updater.setConfig. `beta` maps to prerelease.
  autoUpdate?: AutoUpdateSettings;
  // Semantic-assertion judge (rs.judge in test scripts). Desktop-only for now
  // (web has no /api/ai route). See src/lib/shared/judgeBridge.ts.
  judge?: JudgeSettings;
}

/**
 * Config for the LLM-as-judge backing `rs.judge(...)` in test scripts.
 * Consumed by `makeRendererJudge` in `src/lib/shared/judgeBridge.ts`.
 */
export interface JudgeSettings {
  enabled: boolean;
  provider: Provider;
  model: string;
  /** SecretRef handle id for the provider API key (absent for keyless local runtimes). */
  apiKeyHandleId?: string;
  /** Base URL override; required by the IPC for local providers (ollama/openai-compatible). */
  baseUrl?: string;
  /** Redact the candidate output before sending it to the judge LLM. Default true. */
  redactBeforeJudge: boolean;
}

/**
 * Single source of truth for the default judge config. Referenced by the
 * settings-store default, its `updateJudge` fallback (pre-judge persisted state
 * lacks the field), and the settings UI. Off by default; redact-before-judge ON
 * (don't ship raw API responses to a cloud LLM unprompted).
 */
export const DEFAULT_JUDGE_SETTINGS: JudgeSettings = {
  enabled: false,
  provider: 'openai',
  model: '',
  redactBeforeJudge: true,
};

export interface AutoUpdateSettings {
  autoDownload: boolean;
  channel: 'stable' | 'beta';
}

/** Single source of truth for the default auto-updater preferences. */
export const DEFAULT_AUTO_UPDATE_SETTINGS: AutoUpdateSettings = {
  autoDownload: true,
  channel: 'stable',
};

export type SpatialAccent = '#2e91ff' | '#7c5cff' | '#22c55e' | '#f59e0b' | '#ef4444' | '#06b6d4';

export const SPATIAL_ACCENT_PRESETS: ReadonlyArray<SpatialAccent> = [
  '#2e91ff',
  '#7c5cff',
  '#22c55e',
  '#f59e0b',
  '#ef4444',
  '#06b6d4',
];

// Alias for backwards compatibility and clarity
export type GlobalSettings = AppSettings;

// Active sidebar panel
export type ActivePanel = 'collections' | 'history' | 'workflows' | 'runs';

// Postman Collection Format (simplified)
export interface PostmanVariable {
  key: string;
  value: string;
  type?: string;
}

export interface PostmanAuth {
  type: string;
  [key: string]: unknown;
}

export interface PostmanRequest {
  method: string;
  header: Array<{
    key: string;
    value: string;
    disabled?: boolean;
    description?: string;
  }>;
  /**
   * Postman v2.1 allows a plain string or a structured object. We EXPORT the
   * string form: the postman-collection SDK ignores `raw` when given an
   * object and rebuilds the URL from structured fields (protocol/host/path),
   * so an object carrying only `{ raw, query }` round-trips as a broken URL.
   * The string form is parsed correctly, template variables included.
   */
  url:
    | string
    | {
        raw: string;
        query?: Array<{
          key: string;
          value: string;
          disabled?: boolean;
          description?: string;
        }>;
      };
  body?: {
    mode: string;
    raw?: string;
    options?: unknown;
  };
  auth?: PostmanAuth;
}

export interface PostmanItem {
  name: string;
  request?: PostmanRequest;
  item?: PostmanItem[];
  /** Folder-level auth (Postman item groups support an auth block). */
  auth?: PostmanAuth;
  event?: Array<{
    listen: string;
    script: {
      type: string;
      exec: string[];
    };
  }>;
}

export interface PostmanCollection {
  info: {
    name: string;
    description?: string;
    schema: string;
  };
  item: PostmanItem[];
  auth?: PostmanAuth;
  variable?: PostmanVariable[];
  /** Collection-level pre-request / test event scripts. */
  event?: Array<{
    listen: string;
    script: {
      type: string;
      exec: string[];
    };
  }>;
}

// Insomnia Collection Format (simplified)
export interface InsomniaResource {
  _id: string;
  _type: string;
  name?: string;
  description?: string;
  method?: string;
  url?: string;
  headers?: Array<{
    name: string;
    value: string;
    disabled?: boolean;
  }>;
  parameters?: Array<{
    name: string;
    value: string;
    disabled?: boolean;
  }>;
  body?: {
    mimeType: string;
    text: string;
  };
  authentication?: {
    /** Absent for no-auth — Insomnia's native export uses an empty object. */
    type?: string;
    [key: string]: unknown;
  };
  parentId?: string;
  data?: Record<string, unknown>; // For environment variables
  /** Insomnia 8+ pre-request script (runs before request is sent) */
  preRequestScript?: string;
  /** Insomnia 8+ after-response script (semantically equivalent to "tests") */
  afterResponseScript?: string;
}

export interface InsomniaCollection {
  _type: string;
  __export_format: number;
  __export_date?: string;
  __export_source?: string;
  resources: InsomniaResource[];
}

// Insomnia v5 format (Insomnia 2024+). YAML/JSON, nested instead of the flat
// v4 `resources[]`+`parentId` graph: folders carry `children`, environments
// live under a top-level `environments` object. Request-level fields mirror v4.
export interface InsomniaV5Item {
  name?: string;
  meta?: Record<string, unknown>;
  // Request fields (absent on folders)
  url?: string;
  method?: string;
  headers?: Array<{ name: string; value: string; disabled?: boolean }>;
  parameters?: Array<{ name: string; value: string; disabled?: boolean }>;
  body?: {
    mimeType?: string;
    text?: string;
    params?: Array<{ name: string; value: string; disabled?: boolean }>;
  };
  authentication?: {
    type?: string;
    [key: string]: unknown;
  };
  scripts?: { preRequest?: string; afterResponse?: string };
  // Folder field (presence ⇒ folder)
  children?: InsomniaV5Item[];
}

export interface InsomniaV5Environments {
  name?: string;
  data?: Record<string, unknown>;
  subEnvironments?: Array<{ name?: string; data?: Record<string, unknown> }>;
}

export interface InsomniaV5Document {
  type: string; // e.g. "collection.insomnia.rest/5.0"
  name?: string;
  meta?: Record<string, unknown>;
  collection?: InsomniaV5Item[];
  environments?: InsomniaV5Environments;
}

// OpenAPI/Swagger Types
export interface OpenAPIDocument {
  openapi?: string; // OpenAPI 3.x
  swagger?: string; // Swagger 2.0
  info: OpenAPIInfo;
  servers?: OpenAPIServer[];
  host?: string; // Swagger 2.0
  basePath?: string; // Swagger 2.0
  schemes?: string[]; // Swagger 2.0
  paths: Record<string, OpenAPIPathItem>;
  components?: OpenAPIComponents;
  definitions?: Record<string, OpenAPISchema>; // Swagger 2.0
  securityDefinitions?: Record<string, OpenAPISecurityScheme>; // Swagger 2.0
  tags?: OpenAPITag[];
}

export interface OpenAPIInfo {
  title: string;
  description?: string;
  version: string;
}

export interface OpenAPIServer {
  url: string;
  description?: string;
  variables?: Record<string, OpenAPIServerVariable>;
}

export interface OpenAPIServerVariable {
  default: string;
  enum?: string[];
  description?: string;
}

export interface OpenAPITag {
  name: string;
  description?: string;
}

export interface OpenAPIPathItem {
  get?: OpenAPIOperation;
  post?: OpenAPIOperation;
  put?: OpenAPIOperation;
  delete?: OpenAPIOperation;
  patch?: OpenAPIOperation;
  options?: OpenAPIOperation;
  head?: OpenAPIOperation;
  trace?: OpenAPIOperation;
  parameters?: OpenAPIParameter[];
}

export interface OpenAPIOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: OpenAPIParameter[];
  requestBody?: OpenAPIRequestBody;
  responses?: Record<string, OpenAPIResponse>;
  security?: Array<Record<string, string[]>>;
  deprecated?: boolean;
}

export interface OpenAPIParameter {
  name: string;
  in: 'query' | 'header' | 'path' | 'cookie' | 'body' | 'formData';
  description?: string;
  required?: boolean;
  schema?: OpenAPISchema;
  type?: string; // Swagger 2.0
  default?: unknown;
  example?: unknown;
}

export interface OpenAPIRequestBody {
  description?: string;
  required?: boolean;
  content?: Record<string, OpenAPIMediaType>;
}

export interface OpenAPIMediaType {
  schema?: OpenAPISchema;
  example?: unknown;
  examples?: Record<string, { value: unknown }>;
}

export interface OpenAPIResponse {
  description?: string;
  content?: Record<string, OpenAPIMediaType>;
}

export interface OpenAPISchema {
  type?: string;
  format?: string;
  properties?: Record<string, OpenAPISchema>;
  items?: OpenAPISchema;
  required?: string[];
  example?: unknown;
  default?: unknown;
  enum?: unknown[];
  $ref?: string;
  description?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  allOf?: OpenAPISchema[];
  oneOf?: OpenAPISchema[];
  anyOf?: OpenAPISchema[];
  nullable?: boolean;
}

export interface OpenAPIComponents {
  schemas?: Record<string, OpenAPISchema>;
  securitySchemes?: Record<string, OpenAPISecurityScheme>;
}

export interface OpenAPISecurityScheme {
  type: string;
  name?: string;
  in?: string;
  scheme?: string;
  bearerFormat?: string;
  flows?: Record<string, unknown>;
}

// Workflow Types (Request Chaining & Flows)
export type ExtractionMethod = 'jsonpath' | 'regex' | 'header';

export interface VariableExtraction {
  id: string;
  variableName: string;
  extractionMethod: ExtractionMethod;
  path: string; // JSONPath (dot notation), regex pattern, or header name
  description?: string;
}

export interface WorkflowRequest {
  id: string;
  requestId: string; // Reference to actual request in collection
  name: string;
  extractVariables?: VariableExtraction[];
  precondition?: string; // Script for conditional execution
  retryPolicy?: {
    maxAttempts: number;
    delayMs: number;
    backoffMultiplier?: number;
  };
  timeout?: number; // Override global timeout
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  collectionId: string;
  /**
   * Linear list of workflow steps. When `graph` is also present, this is
   * a BAG (insertion order is meaningless) — the graph's edges are the
   * authoritative execution order. The legacy linear executor refuses to
   * run a workflow with a non-null `graph`; only the DAG executor does.
   */
  requests: WorkflowRequest[];
  variables?: KeyValue[]; // Workflow-level variables
  /**
   * Optional DAG authored via the React Flow canvas. When present, the
   * workflow runs through the DAG executor and the form view becomes
   * read-only (with a "Discard graph" button). Absent for workflows
   * created in linear form view only.
   */
  graph?: WorkflowGraph;
  createdAt: number;
  updatedAt: number;
}

// React Flow DAG types
// ---------------------

export interface FlowNodePosition {
  x: number;
  y: number;
}

export type ParallelWaitMode = 'all' | 'any' | 'race';
export type ParallelMergeStrategy = 'fail-on-conflict' | 'pick-first' | 'pick-last' | 'merge-list';

/** What counts as failure for a request node. Drives surrounding try/catch. */
export type RequestFailureMode = 'thrown-only' | 'http-status' | 'never';

/**
 * When does a streaming-node terminate?
 *
 * `eventCount` — after N events received.
 * `timeoutMs` — after a wall-clock duration regardless of activity.
 * `eventMatch` — when a QuickJS predicate on the latest event returns truthy.
 * `connectionClose` — when the server closes the stream (or `close()` fires).
 */
export type CompletionPolicy =
  | { kind: 'eventCount'; n: number }
  | { kind: 'timeoutMs'; ms: number }
  | { kind: 'eventMatch'; expression: string }
  | { kind: 'connectionClose' };

export type FlowNodeKind =
  | 'start'
  | 'end'
  | 'request'
  | 'condition'
  | 'switch'
  | 'setVariable'
  | 'delay'
  | 'transform'
  | 'template'
  | 'display'
  | 'parallel'
  | 'forEach'
  | 'loop'
  | 'tryCatch'
  | 'subWorkflow'
  | 'sseSubscribe'
  | 'wsExchange'
  | 'mcpCall';

interface FlowNodeBase {
  id: string;
  kind: FlowNodeKind;
  position: FlowNodePosition;
}

export interface StartFlowNode extends FlowNodeBase {
  kind: 'start';
}

export interface EndFlowNode extends FlowNodeBase {
  kind: 'end';
}

export interface RequestFlowNode extends FlowNodeBase {
  kind: 'request';
  data: {
    /** Points at a WorkflowRequest in Workflow.requests[]. */
    workflowRequestId: string;
    /** Default 'thrown-only' — non-2xx responses do NOT auto-fail. */
    failureMode?: RequestFailureMode;
  };
}

export interface ConditionFlowNode extends FlowNodeBase {
  kind: 'condition';
  data: {
    /** QuickJS expression — must `return` a value coerced to boolean. */
    expression: string;
    description?: string;
  };
}

/** One branch of a switch node. The first case whose expression returns
 *  truthy wins; if none match, the `'default'` source handle is taken. */
export interface SwitchCase {
  /** Stable id, used as the React Flow source-handle id for this branch. */
  id: string;
  label?: string;
  /** QuickJS expression — coerced to boolean, evaluated in declared order. */
  expression: string;
}

export interface SwitchFlowNode extends FlowNodeBase {
  kind: 'switch';
  data: {
    cases: SwitchCase[];
    description?: string;
  };
}

export type LoopMode = 'while' | 'until';

/** Condition-driven loop (polling). Unlike forEach it shares the parent
 *  variable scope so body mutations affect the next condition check. */
export interface LoopFlowNode extends FlowNodeBase {
  kind: 'loop';
  data: {
    /** QuickJS expression evaluated before each pass — coerced to boolean. */
    conditionExpression: string;
    /** 'while' runs the body while the condition is truthy; 'until' runs
     *  until the condition becomes truthy. */
    mode: LoopMode;
    /** Hard cap on iterations — prevents a runaway loop. */
    maxIterations: number;
    /** Optional pause between iterations (ms). */
    delayMs?: number;
    /** Body executed each iteration. */
    subgraph: WorkflowGraph;
  };
}

export interface SetVariableAssignment {
  key: string;
  /** QuickJS expression evaluated to a string. */
  valueExpression: string;
}

export interface SetVariableFlowNode extends FlowNodeBase {
  kind: 'setVariable';
  data: {
    assignments: SetVariableAssignment[];
  };
}

export interface DelayFlowNode extends FlowNodeBase {
  kind: 'delay';
  data: {
    ms: number;
  };
}

export interface TransformFlowNode extends FlowNodeBase {
  kind: 'transform';
  data: {
    /** QuickJS script. Variables set via `pm.variables.set` propagate. */
    script: string;
  };
}

/** Render a {{var}}-interpolated string into a single variable. The
 *  declarative counterpart to a transform script. */
export interface TemplateFlowNode extends FlowNodeBase {
  kind: 'template';
  data: {
    /** Text with {{varName}} tokens substituted from workflow variables. */
    template: string;
    /** Variable name receiving the rendered string. */
    resultVar: string;
  };
}

export type DisplayMode = 'json' | 'table' | 'raw';

/** Capture a value for inspection in the run monitor. Side-effect only —
 *  does not mutate downstream variables beyond `<nodeId>.display`. */
export interface DisplayFlowNode extends FlowNodeBase {
  kind: 'display';
  data: {
    /** QuickJS expression evaluated to the value to display. */
    valueExpression: string;
    /** How the run monitor renders the captured value. */
    mode: DisplayMode;
    /** Optional label shown beside the value. */
    label?: string;
  };
}

export interface ParallelFlowNode extends FlowNodeBase {
  kind: 'parallel';
  data: {
    waitMode: ParallelWaitMode;
    mergeStrategy?: ParallelMergeStrategy;
  };
}

export interface ForEachFlowNode extends FlowNodeBase {
  kind: 'forEach';
  data: {
    /** QuickJS expression that must return a JSON-serialisable array. */
    collectionExpression: string;
    /** Variable name receiving each item (JSON-encoded) per iteration. */
    iteratorVar: string;
    /** Subgraph executed once per item. Max concurrency 8 in v1. */
    subgraph: WorkflowGraph;
    /** Optional override for the v1 default concurrency cap of 8. */
    concurrency?: number;
  };
}

export interface TryCatchFlowNode extends FlowNodeBase {
  kind: 'tryCatch';
  data: {
    trySubgraph: WorkflowGraph;
    catchSubgraph: WorkflowGraph;
  };
}

export interface SubWorkflowFlowNode extends FlowNodeBase {
  kind: 'subWorkflow';
  data: {
    workflowId: string;
    /** parent var name → child var name. Child sees only mapped vars. */
    inputVarMap?: Record<string, string>;
    /** child var name → parent var name. Defaults to no projection. */
    outputVarMap?: Record<string, string>;
  };
}

/** Subscribe to a saved SseRequest, accumulate events, terminate per completion policy. */
export interface SseSubscribeFlowNode extends FlowNodeBase {
  kind: 'sseSubscribe';
  data: {
    /** Points at a WorkflowRequest in Workflow.requests[] whose
     *  underlying collection request is an SseRequest. */
    workflowRequestId: string;
    completion: CompletionPolicy;
    /** When false, only events matching the `eventMatch` predicate are
     *  accumulated (no-op for other completion kinds — all events kept). */
    accumulateAll?: boolean;
    /** Maximum number of events to collect into `resultVar`. Defaults to
     *  10_000 — prevents a runaway stream from filling memory with a
     *  massive variable. When the cap is hit, the stream closes early
     *  and the node settles as `success` with a warning logged. */
    maxEvents?: number;
    /** Variable to receive the JSON-stringified events array.
     *  Defaults to `<nodeId>.events`. */
    resultVar?: string;
    failureMode?: RequestFailureMode;
  };
}

/** Send one frame to a WebSocket endpoint and wait for a matching reply. */
export interface WsExchangeFlowNode extends FlowNodeBase {
  kind: 'wsExchange';
  data: {
    /** WebSocket URL (`ws:` or `wss:`). Inline because there's no
     *  WebSocketRequest type in the collection model today. */
    url: string;
    /** QuickJS expression evaluated to the frame to send on open. */
    sendExpression: string;
    /** QuickJS predicate against `event` — first truthy match wins. */
    matchExpression: string;
    completion: CompletionPolicy;
    /** Variable to receive the matched reply (JSON-stringified).
     *  Defaults to `<nodeId>.reply`. */
    resultVar?: string;
    failureMode?: RequestFailureMode;
  };
}

/** Call one JSON-RPC method on an MCP server. */
export interface McpCallFlowNode extends FlowNodeBase {
  kind: 'mcpCall';
  data: {
    workflowRequestId: string;
    /** Method to invoke — e.g. "tools/call", "resources/read". */
    method: string;
    /** QuickJS expression evaluating to the JSON params object. Optional. */
    paramsExpression?: string;
    /** Variable to receive the JSON-stringified result.
     *  Defaults to `<nodeId>.result`. */
    resultVar?: string;
    failureMode?: RequestFailureMode;
  };
}

export type FlowNode =
  | StartFlowNode
  | EndFlowNode
  | RequestFlowNode
  | ConditionFlowNode
  | SwitchFlowNode
  | SetVariableFlowNode
  | DelayFlowNode
  | TransformFlowNode
  | TemplateFlowNode
  | DisplayFlowNode
  | ParallelFlowNode
  | ForEachFlowNode
  | LoopFlowNode
  | TryCatchFlowNode
  | SubWorkflowFlowNode
  | SseSubscribeFlowNode
  | WsExchangeFlowNode
  | McpCallFlowNode;

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  /**
   * For condition nodes: 'true' | 'false'. For tryCatch internal edges:
   * 'try' | 'catch'. Undefined for ordinary edges. Matches the React Flow
   * v12 `<Handle id="…" />` convention.
   */
  sourceHandle?: string;
  label?: string;
}

/**
 * Path into a workflow's nested subgraphs. Empty array = top-level.
 * Each segment names the parent node and which of its nested graph
 * slots to descend into.
 *
 *   []                                                    -> workflow.graph
 *   [{parentNodeId: 'fe', key: 'subgraph'}]               -> forEach's / loop's body
 *   [{parentNodeId: 'tc', key: 'trySubgraph'}, ...]       -> tryCatch's try-branch, then drill deeper
 */
export type SubgraphPath = ReadonlyArray<{
  parentNodeId: string;
  key: 'subgraph' | 'trySubgraph' | 'catchSubgraph';
}>;

export interface WorkflowGraph {
  /** Bumped when the graph schema changes; v1 in this release. */
  version: 1;
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** Persisted React Flow viewport so the user's pan/zoom survives reload. */
  viewport?: { x: number; y: number; zoom: number };
}

// Execution history
// -----------------

export interface WorkflowExecutionStep {
  /**
   * Legacy linear step pointed at a `WorkflowRequest` (workflowRequestId)
   * which pointed at a collection request (requestId). Graph executions
   * have many more node kinds, so these become optional and the new
   * `nodeId` / `nodeKind` fields take over. The history viewer branches
   * on `nodeKind` — when absent, it falls back to the legacy rendering.
   */
  workflowRequestId?: string;
  requestId?: string;
  requestName: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  response?: Response;
  extractedVariables?: Record<string, string>;
  error?: string;
  duration?: number;
  timestamp: number;
  /** Present for graph executions; absent for legacy linear executions. */
  nodeId?: string;
  nodeKind?: FlowNodeKind;
}

export interface WorkflowExecution {
  id: string;
  workflowId: string;
  workflowName: string;
  startedAt: number;
  completedAt?: number;
  status: 'running' | 'success' | 'failed' | 'stopped';
  steps: WorkflowExecutionStep[];
  finalVariables: Record<string, string>;
  environment?: string; // Environment ID used
  executionLog: Array<{
    timestamp: number;
    message: string;
    level: 'info' | 'warn' | 'error';
  }>;
}
