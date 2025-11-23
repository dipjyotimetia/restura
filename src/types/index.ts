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
export type RequestType = 'http' | 'grpc';

// Request Mode (used for UI mode switching)
export type RequestMode = 'http' | 'grpc' | 'websocket' | 'graphql';

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
export type AuthType = 'none' | 'basic' | 'bearer' | 'api-key' | 'oauth2' | 'digest' | 'aws-signature';

// Key-Value Pair
export interface KeyValue {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
  description?: string;
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
    scopes?: string[];
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

// Union type for any request
export type Request = HttpRequest | GrpcRequest;

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
}

// Alias for backwards compatibility and clarity
export type GlobalSettings = AppSettings;

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
