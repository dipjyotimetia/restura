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
