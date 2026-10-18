import { z } from 'zod';
import { HTTP_METHOD_TOKEN_RE, MAX_HTTP_METHOD_LENGTH } from '../protocol/http-method';
import { secretValueSchema } from '../secrets/secret-ref';
import { GRAPHQL_SUBSCRIPTION_PROTOCOLS, HTTP_VERSION_PREFERENCES } from '../types/http';
import { kafkaRequestSchema, mqttRequestSchema } from './broker';
import { keyValueSchema } from './key-value';

// HTTP Method Schema
// Any RFC 9110 token (#857). CONNECT/TRACE/TRACK are deliberately NOT rejected here:
// persisted/imported state must not be dropped wholesale for one bad method —
// the shared HTTP core refuses them at send time instead.
export const httpMethodSchema = z
  .string()
  .max(MAX_HTTP_METHOD_LENGTH)
  .regex(HTTP_METHOD_TOKEN_RE, { message: 'Invalid HTTP method token' });

// URL Schema
export const urlSchema = z
  .string()
  .url({ message: 'Invalid URL format' })
  .or(z.string().regex(/^https?:\/\//, { message: 'URL must start with http:// or https://' }));

export { kafkaRequestSchema, mqttRequestSchema } from './broker';
export { keyValueSchema } from './key-value';

/** Variables with scope/export metadata. Request headers and params remain KeyValue. */
export const scopedVariableSchema = keyValueSchema.extend({
  private: z.boolean().optional(),
  secretRef: secretValueSchema.optional(),
});

// Proxy type literal — single source of truth for the ProxyType union (reused
// by the persisted-settings validator so the enum isn't re-declared per layer).
export const proxyTypeSchema = z.enum(['none', 'http', 'https', 'socks4', 'socks5']);

// Proxy Config Schema
export const proxyConfigSchema = z.object({
  enabled: z.boolean(),
  type: proxyTypeSchema,
  host: z.string(),
  port: z.number(),
  auth: z
    .object({
      username: z.string(),
      password: z.string(),
    })
    .optional(),
  bypassList: z.array(z.string()).optional(),
});

// Minimum TLS version literal — kept in sync with the MinTlsVersion type in
// src/types/index.ts (Node tls.connect minVersion values).
export const minTlsVersionSchema = z.enum(['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3']);

// Per-request HTTP version preference (#864) — derived from the single list in
// shared/types/http.ts. Desktop-only at the wire.
export const httpVersionPreferenceSchema = z.enum(HTTP_VERSION_PREFERENCES);

// Request Settings Schema
export const requestSettingsSchema = z.object({
  timeout: z.number(),
  followRedirects: z.boolean(),
  maxRedirects: z.number(),
  verifySsl: z.boolean(),
  proxy: proxyConfigSchema.optional(),
  // Redirect policy
  followOriginalMethod: z.boolean().optional(),
  followAuthHeader: z.boolean().optional(),
  stripReferer: z.boolean().optional(),
  // URL handling
  encodeUrlAutomatically: z.boolean().optional(),
  // Cookies
  disableCookieJar: z.boolean().optional(),
  // TLS (desktop-only enforcement, schema accepts on all platforms so workspace defaults persist consistently)
  serverCipherOrder: z.boolean().optional(),
  minTlsVersion: minTlsVersionSchema.optional(),
  cipherSuites: z.string().optional(),
  // Protocol version (desktop-only enforcement)
  httpVersion: httpVersionPreferenceSchema.optional(),
});

// Auth Schema
export const authConfigSchema = z.object({
  type: z.enum([
    'none',
    'basic',
    'bearer',
    'api-key',
    'oauth2',
    'digest',
    'aws-signature',
    'oauth1',
    'ntlm',
    'wsse',
  ]),
  basic: z
    .object({
      username: z.string(),
      password: secretValueSchema,
    })
    .optional(),
  bearer: z
    .object({
      token: secretValueSchema,
    })
    .optional(),
  apiKey: z
    .object({
      key: z.string(),
      value: secretValueSchema,
      in: z.enum(['header', 'query']),
    })
    .optional(),
  oauth2: z
    .object({
      // Optional: the token is fetched AFTER the user fills clientId/tokenUrl/etc.
      // Requiring it rejected every pre-token config edit (validateRequestUpdate
      // throws → updateRequest drops it), making OAuth2 unconfigurable in the UI.
      accessToken: secretValueSchema.optional(),
      tokenType: z.string().optional(),
      refreshToken: secretValueSchema.optional(),
      expiresAt: z.number().optional(),
      scopes: z.array(z.string()).optional(),
      grantType: z
        .enum(['authorization_code', 'client_credentials', 'password', 'device_code'])
        .optional(),
      clientId: z.string().optional(),
      clientSecret: secretValueSchema.optional(),
      authorizationUrl: z.string().optional(),
      tokenUrl: z.string().optional(),
      deviceAuthorizationUrl: z.string().optional(),
      scope: z.string().optional(),
      redirectUri: z.string().optional(),
      username: z.string().optional(),
      password: secretValueSchema.optional(),
    })
    .optional(),
  digest: z
    .object({
      username: z.string(),
      password: secretValueSchema,
    })
    .optional(),
  awsSignature: z
    .object({
      accessKey: z.string(),
      secretKey: secretValueSchema,
      region: z.string(),
      service: z.string(),
    })
    .optional(),
  oauth1: z
    .object({
      consumerKey: z.string(),
      consumerSecret: secretValueSchema,
      accessToken: secretValueSchema.optional(),
      accessTokenSecret: secretValueSchema.optional(),
      signatureMethod: z.enum(['HMAC-SHA1', 'HMAC-SHA256', 'PLAINTEXT']).optional(),
      realm: z.string().optional(),
      nonce: z.string().optional(),
      timestamp: z.string().optional(),
      addParamsToBody: z.boolean().optional(),
    })
    .optional(),
  ntlm: z
    .object({
      username: z.string(),
      password: secretValueSchema,
      domain: z.string().optional(),
      workstation: z.string().optional(),
    })
    .optional(),
  wsse: z
    .object({
      username: z.string(),
      password: secretValueSchema,
      passwordType: z.enum(['PasswordDigest', 'PasswordText']).optional(),
    })
    .optional(),
});

// Imported GraphQL schema (SDL / introspection JSON stored as canonical SDL).
export const graphqlImportedSchemaSchema = z.object({
  sdl: z.string(),
  source: z.enum(['sdl', 'introspection']),
  fileName: z.string().optional(),
  importedAt: z.number(),
});

export const graphqlSubscriptionProtocolSchema = z.enum(GRAPHQL_SUBSCRIPTION_PROTOCOLS);

// HTTP Request Schema
export const httpRequestSchema = z.object({
  id: z.string(),
  name: z.string().min(1, 'Name is required'),
  type: z.literal('http'),
  method: httpMethodSchema,
  url: z.string(),
  headers: z.array(keyValueSchema),
  params: z.array(keyValueSchema),
  body: z.object({
    type: z.enum([
      'none',
      'json',
      'xml',
      'form-data',
      'x-www-form-urlencoded',
      'binary',
      'text',
      'graphql',
      'protobuf',
      'multipart-mixed',
    ]),
    raw: z.string().optional(),
    graphqlVariables: z.string().optional(),
    graphqlOperationName: z.string().optional(),
    formData: z.array(z.any()).optional(),
    binary: z.any().optional(),
    multipartParts: z.array(z.any()).optional(),
  }),
  auth: authConfigSchema,
  preRequestScript: z.string().optional(),
  testScript: z.string().optional(),
  description: z.string().optional(),
  // Partial: omitted fields follow the workspace defaults (RequestSettingsOverride).
  settings: requestSettingsSchema.partial().optional(),
  graphqlSchema: graphqlImportedSchemaSchema.optional(),
  graphqlSubscriptionProtocol: graphqlSubscriptionProtocolSchema.optional(),
});

// gRPC Request Schema
export const grpcRequestSchema = z.object({
  id: z.string(),
  name: z.string().min(1, 'Name is required'),
  type: z.literal('grpc'),
  methodType: z.enum(['unary', 'server-streaming', 'client-streaming', 'bidirectional-streaming']),
  url: z.string(),
  service: z.string(),
  method: z.string(),
  metadata: z.array(keyValueSchema),
  message: z.string(),
  auth: authConfigSchema,
  preRequestScript: z.string().optional(),
  testScript: z.string().optional(),
  schema: z
    .discriminatedUnion('kind', [
      z.object({
        kind: z.literal('descriptors'),
        descriptors: z.array(z.string()),
        // Set for a user upload (multi-file .proto / FileDescriptorSet) — #891.
        fileName: z.string().optional(),
        hash: z.string().optional(),
        fetchedAt: z.number().optional(),
      }),
      z.object({
        kind: z.literal('proto'),
        fileName: z.string(),
        text: z.string(),
        hash: z.string().optional(),
        fetchedAt: z.number().optional(),
      }),
    ])
    .optional(),
  // 0 = "no deadline" (streaming methods only; unary falls back to the default).
  timeout: z.number().int().nonnegative().optional(),
  wireProtocol: z.enum(['grpc', 'connect', 'grpc-web', 'grpc-web-text']).optional(),
});

// SSE Request Schema
export const sseRequestSchema = z.object({
  id: z.string(),
  name: z.string().min(1, 'Name is required'),
  type: z.literal('sse'),
  url: z.string(),
  headers: z.array(keyValueSchema),
  params: z.array(keyValueSchema),
  auth: authConfigSchema,
  eventFilter: z.array(z.string()).optional(),
  reconnectOnResume: z.boolean().optional(),
  preRequestScript: z.string().optional(),
  testScript: z.string().optional(),
});

// MCP Request Schema
export const mcpRequestSchema = z.object({
  id: z.string(),
  name: z.string().min(1, 'Name is required'),
  type: z.literal('mcp'),
  url: z.string(),
  transport: z.enum(['streamable-http', 'http-sse']),
  headers: z.array(keyValueSchema),
  auth: authConfigSchema,
  defaultMethod: z.string().optional(),
  defaultParams: z.string().optional(),
  preRequestScript: z.string().optional(),
  testScript: z.string().optional(),
});

// Environment Schema
export const environmentSchema = z.object({
  id: z.string(),
  name: z.string().min(1, 'Name is required'),
  collectionId: z.string().optional(),
  parentId: z.string().optional(),
  variables: z.array(scopedVariableSchema),
});

// Contract Spec Source Schema (pointer only — spec text loads on demand)
export const contractSpecSourceSchema = z.object({
  kind: z.enum(['openapi', 'asyncapi']).optional(),
  source: z.enum(['url', 'inline', 'file']),
  url: z.string().optional(),
  inline: z.string().optional(),
  filePath: z.string().optional(),
});

// Collection Schema
// biome-ignore lint/suspicious/noExplicitAny: z.ZodType<any> is required for recursive Zod schemas
export const collectionSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    id: z.string(),
    name: z.string().min(1, 'Name is required'),
    description: z.string().optional(),
    items: z.array(collectionItemSchema),
    auth: authConfigSchema.optional(),
    variables: z.array(scopedVariableSchema).optional(),
    contractSpec: contractSpecSourceSchema.optional(),
    preRequestScript: z.string().optional(),
    testScript: z.string().optional(),
  })
);

// biome-ignore lint/suspicious/noExplicitAny: z.ZodType<any> is required for recursive Zod schemas
export const collectionItemSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    id: z.string(),
    name: z.string(),
    type: z.enum(['folder', 'request']),
    request: z
      // Discriminated on `type` so a malformed request reports the real
      // mismatch (and validates in one pass) instead of trying every arm.
      .discriminatedUnion('type', [
        httpRequestSchema,
        grpcRequestSchema,
        sseRequestSchema,
        mcpRequestSchema,
        kafkaRequestSchema,
        mqttRequestSchema,
      ])
      .optional(),
    items: z.array(collectionItemSchema).optional(),
    variables: z.array(scopedVariableSchema).optional(),
    auth: authConfigSchema.optional(),
    contractSpec: contractSpecSourceSchema.optional(),
    preRequestScript: z.string().optional(),
    testScript: z.string().optional(),
  })
);

// JSON Validator
export const validateJSON = (value: string): boolean => {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
};

/**
 * Format a Zod parse error as a short human-readable string for surfacing
 * in error messages. Caps at `max` issues so a deeply broken document
 * doesn't dump kilobytes into the toast.
 */
export function formatZodIssues(error: z.ZodError, max = 5): string {
  return error.issues
    .slice(0, max)
    .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('; ');
}
