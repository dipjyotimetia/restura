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
export type RequestMode = 'http' | 'grpc' | 'websocket' | 'graphql' | 'sse' | 'mcp' | 'kafka';

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
}

// Collection
export interface Collection {
  id: string;
  name: string;
  description?: string;
  items: CollectionItem[];
  auth?: AuthConfig;
  variables?: KeyValue[];
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
  requests: WorkflowRequest[];
  variables?: KeyValue[]; // Workflow-level variables
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowExecutionStep {
  workflowRequestId: string;
  requestId: string;
  requestName: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  response?: Response;
  extractedVariables?: Record<string, string>;
  error?: string;
  duration?: number;
  timestamp: number;
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
