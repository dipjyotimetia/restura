import { z } from 'zod';

// HTTP Method Schema
export const httpMethodSchema = z.enum([
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'OPTIONS',
  'HEAD',
]);

// URL Schema
export const urlSchema = z.string().url({ message: 'Invalid URL format' }).or(
  z.string().regex(/^https?:\/\//, { message: 'URL must start with http:// or https://' })
);

// Key-Value Schema
export const keyValueSchema = z.object({
  id: z.string(),
  key: z.string(),
  value: z.string(),
  enabled: z.boolean(),
  description: z.string().optional(),
});

// Proxy Config Schema
export const proxyConfigSchema = z.object({
  enabled: z.boolean(),
  type: z.enum(['none', 'http', 'https', 'socks4', 'socks5']),
  host: z.string(),
  port: z.number(),
  auth: z.object({
    username: z.string(),
    password: z.string(),
  }).optional(),
  bypassList: z.array(z.string()).optional(),
});

// Request Settings Schema
export const requestSettingsSchema = z.object({
  timeout: z.number(),
  followRedirects: z.boolean(),
  maxRedirects: z.number(),
  verifySsl: z.boolean(),
  proxy: proxyConfigSchema.optional(),
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
      password: z.string(),
    })
    .optional(),
  bearer: z
    .object({
      token: z.string(),
    })
    .optional(),
  apiKey: z
    .object({
      key: z.string(),
      value: z.string(),
      in: z.enum(['header', 'query']),
    })
    .optional(),
  oauth2: z
    .object({
      accessToken: z.string(),
      tokenType: z.string().optional(),
      scopes: z.array(z.string()).optional(),
      grantType: z
        .enum(['authorization_code', 'client_credentials', 'password', 'device_code'])
        .optional(),
      clientId: z.string().optional(),
      clientSecret: z.string().optional(),
      authorizationUrl: z.string().optional(),
      tokenUrl: z.string().optional(),
      deviceAuthorizationUrl: z.string().optional(),
      scope: z.string().optional(),
      redirectUri: z.string().optional(),
      username: z.string().optional(),
      password: z.string().optional(),
    })
    .optional(),
  digest: z
    .object({
      username: z.string(),
      password: z.string(),
    })
    .optional(),
  awsSignature: z
    .object({
      accessKey: z.string(),
      secretKey: z.string(),
      region: z.string(),
      service: z.string(),
    })
    .optional(),
  oauth1: z
    .object({
      consumerKey: z.string(),
      consumerSecret: z.string(),
      accessToken: z.string().optional(),
      accessTokenSecret: z.string().optional(),
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
      password: z.string(),
      domain: z.string().optional(),
      workstation: z.string().optional(),
    })
    .optional(),
  wsse: z
    .object({
      username: z.string(),
      password: z.string(),
      passwordType: z.enum(['PasswordDigest', 'PasswordText']).optional(),
    })
    .optional(),
});

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
    type: z.enum(['none', 'json', 'xml', 'form-data', 'x-www-form-urlencoded', 'binary', 'text', 'graphql', 'protobuf', 'multipart-mixed']),
    raw: z.string().optional(),
    formData: z.array(z.any()).optional(),
    binary: z.any().optional(),
    multipartParts: z.array(z.any()).optional(),
  }),
  auth: authConfigSchema,
  preRequestScript: z.string().optional(),
  testScript: z.string().optional(),
  settings: requestSettingsSchema.optional(),
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
  variables: z.array(keyValueSchema),
});

// Collection Schema
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- z.ZodType<any> is required for recursive Zod schemas
export const collectionSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    id: z.string(),
    name: z.string().min(1, 'Name is required'),
    description: z.string().optional(),
    items: z.array(collectionItemSchema),
    auth: authConfigSchema.optional(),
  })
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- z.ZodType<any> is required for recursive Zod schemas
export const collectionItemSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    id: z.string(),
    name: z.string(),
    type: z.enum(['folder', 'request']),
    request: z.union([httpRequestSchema, grpcRequestSchema, sseRequestSchema, mcpRequestSchema]).optional(),
    items: z.array(collectionItemSchema).optional(),
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

// XML Validator (basic)
export const validateXML = (value: string): boolean => {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(value, 'text/xml');
    return !doc.querySelector('parsererror');
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
