// HTTP Methods
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS' | 'HEAD';

// gRPC Methods
export type GrpcMethodType = 'unary' | 'server-streaming' | 'client-streaming' | 'bidirectional-streaming';

// gRPC Status Codes (https://grpc.github.io/grpc/core/md_doc_statuscodes.html)
export enum GrpcStatusCode {
  OK = 0,
  CANCELLED = 1,
  UNKNOWN = 2,
  INVALID_ARGUMENT = 3,
  DEADLINE_EXCEEDED = 4,
  NOT_FOUND = 5,
  ALREADY_EXISTS = 6,
  PERMISSION_DENIED = 7,
  RESOURCE_EXHAUSTED = 8,
  FAILED_PRECONDITION = 9,
  ABORTED = 10,
  OUT_OF_RANGE = 11,
  UNIMPLEMENTED = 12,
  INTERNAL = 13,
  UNAVAILABLE = 14,
  DATA_LOSS = 15,
  UNAUTHENTICATED = 16,
}

// gRPC Status Code Names
export const GrpcStatusCodeName: Record<GrpcStatusCode, string> = {
  [GrpcStatusCode.OK]: 'OK',
  [GrpcStatusCode.CANCELLED]: 'CANCELLED',
  [GrpcStatusCode.UNKNOWN]: 'UNKNOWN',
  [GrpcStatusCode.INVALID_ARGUMENT]: 'INVALID_ARGUMENT',
  [GrpcStatusCode.DEADLINE_EXCEEDED]: 'DEADLINE_EXCEEDED',
  [GrpcStatusCode.NOT_FOUND]: 'NOT_FOUND',
  [GrpcStatusCode.ALREADY_EXISTS]: 'ALREADY_EXISTS',
  [GrpcStatusCode.PERMISSION_DENIED]: 'PERMISSION_DENIED',
  [GrpcStatusCode.RESOURCE_EXHAUSTED]: 'RESOURCE_EXHAUSTED',
  [GrpcStatusCode.FAILED_PRECONDITION]: 'FAILED_PRECONDITION',
  [GrpcStatusCode.ABORTED]: 'ABORTED',
  [GrpcStatusCode.OUT_OF_RANGE]: 'OUT_OF_RANGE',
  [GrpcStatusCode.UNIMPLEMENTED]: 'UNIMPLEMENTED',
  [GrpcStatusCode.INTERNAL]: 'INTERNAL',
  [GrpcStatusCode.UNAVAILABLE]: 'UNAVAILABLE',
  [GrpcStatusCode.DATA_LOSS]: 'DATA_LOSS',
  [GrpcStatusCode.UNAUTHENTICATED]: 'UNAUTHENTICATED',
};

// Request Types
export type RequestType = 'http' | 'grpc' | 'sse' | 'mcp';

// Request Mode (used for UI mode switching)
// Kafka is connection-based (no Request shape) and Electron-only — the picker
// still surfaces it in the web build but the page renders a "Desktop only" panel.
export type RequestMode = 'http' | 'grpc' | 'websocket' | 'graphql' | 'sse' | 'mcp' | 'kafka' | 'socketio';

// Body Types
export type BodyType = 'none' | 'json' | 'xml' | 'form-data' | 'x-www-form-urlencoded' | 'binary' | 'protobuf' | 'graphql' | 'text' | 'multipart-mixed';

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
  file?: File;
}

// Authentication Configuration
export interface AuthConfig {
  type: AuthType;
  basic?: {
    username: string;
    password: string;
  };
  bearer?: {
    token: string;
  };
  apiKey?: {
    key: string;
    value: string;
    in: 'header' | 'query';
  };
  oauth2?: {
    accessToken: string;
    tokenType?: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
    // Flow configuration
    grantType?: 'authorization_code' | 'client_credentials' | 'password' | 'device_code';
    clientId?: string;
    clientSecret?: string;
    authorizationUrl?: string;
    tokenUrl?: string;
    /** RFC 8628 device authorization endpoint — required for device_code grant */
    deviceAuthorizationUrl?: string;
    scope?: string;
    redirectUri?: string;
    // Password grant only
    username?: string;
    password?: string;
  };
  digest?: {
    username: string;
    password: string;
  };
  awsSignature?: {
    accessKey: string;
    secretKey: string;
    region: string;
    service: string;
  };
  oauth1?: {
    consumerKey: string;
    consumerSecret: string;
    accessToken?: string;
    accessTokenSecret?: string;
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
    password: string;
    domain?: string;
    workstation?: string;
  };
  wsse?: {
    username: string;
    password: string;
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

// SSE event payload, as parsed from the wire format
export interface SseEvent {
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
   * Optional contract spec attached at folder scope (only meaningful when
   * type === 'folder'). Overrides the collection-level spec for any
   * descendant requests.
   */
  contractSpec?: ContractSpecSource;
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
}

// History Item
export interface HistoryItem {
  id: string;
  request: Request;
  response?: Response;
  timestamp: number;
}

// Script Execution Result
export interface ScriptResult {
  success: boolean;
  logs: Array<{ type: 'log' | 'error' | 'warn' | 'info'; message: string; timestamp: number }>;
  errors: string[];
  variables: Record<string, string>;
  tests?: Array<{ name: string; passed: boolean; error?: string }>;
}

// Certificate Configuration
export interface ClientCert {
  format: 'pfx' | 'pem';
  pfx?: string;       // base64-encoded .p12/.pfx content
  cert?: string;      // PEM certificate string
  key?: string;       // PEM private key string (encrypted at rest)
  passphrase?: string;
}

export interface CaCert {
  pem: string;        // PEM-encoded CA certificate chain
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
    password: string;
  };
  bypassList?: string[]; // List of hosts to bypass proxy
}

// Request Settings (per-request configuration)
export interface RequestSettings {
  timeout: number; // in milliseconds
  followRedirects: boolean;
  maxRedirects: number;
  verifySsl: boolean;
  proxy?: ProxyConfig;
  clientCert?: ClientCert;
  caCert?: CaCert;
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
  // Certificate settings
  clientCert?: ClientCert;
  caCert?: CaCert;
}

// Alias for backwards compatibility and clarity
export type GlobalSettings = AppSettings;

// Active sidebar panel
export type ActivePanel = 'collections' | 'history' | 'workflows';

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
  url: {
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
    type: string;
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
export type ParallelMergeStrategy =
  | 'fail-on-conflict'
  | 'pick-first'
  | 'pick-last'
  | 'merge-list';

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
  | 'setVariable'
  | 'delay'
  | 'transform'
  | 'parallel'
  | 'forEach'
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
  | SetVariableFlowNode
  | DelayFlowNode
  | TransformFlowNode
  | ParallelFlowNode
  | ForEachFlowNode
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
 *   [{parentNodeId: 'fe', key: 'subgraph'}]               -> forEach's body
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
