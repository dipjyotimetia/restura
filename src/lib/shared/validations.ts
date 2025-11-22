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

// Auth Schema
export const authConfigSchema = z.object({
  type: z.enum(['none', 'basic', 'bearer', 'api-key', 'oauth2', 'digest', 'aws-signature']),
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
});

// HTTP Request Schema
export const httpRequestSchema = z.object({
  id: z.string(),
  name: z.string().min(1, 'Name is required'),
  type: z.literal('http'),
  method: httpMethodSchema,
  url: z.string().min(1, 'URL is required'),
  headers: z.array(keyValueSchema),
  params: z.array(keyValueSchema),
  body: z.object({
    type: z.enum(['none', 'json', 'xml', 'form-data', 'x-www-form-urlencoded', 'binary', 'text', 'graphql']),
    raw: z.string().optional(),
    formData: z.array(z.any()).optional(),
    binary: z.any().optional(),
  }),
  auth: authConfigSchema,
  preRequestScript: z.string().optional(),
  testScript: z.string().optional(),
});

// gRPC Request Schema
export const grpcRequestSchema = z.object({
  id: z.string(),
  name: z.string().min(1, 'Name is required'),
  type: z.literal('grpc'),
  methodType: z.enum(['unary', 'server-streaming', 'client-streaming', 'bidirectional-streaming']),
  url: z.string().min(1, 'URL is required'),
  service: z.string().min(1, 'Service is required'),
  method: z.string().min(1, 'Method is required'),
  metadata: z.array(keyValueSchema),
  message: z.string(),
  auth: authConfigSchema,
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
export const collectionSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    id: z.string(),
    name: z.string().min(1, 'Name is required'),
    description: z.string().optional(),
    items: z.array(collectionItemSchema),
    auth: authConfigSchema.optional(),
  })
);

export const collectionItemSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    id: z.string(),
    name: z.string(),
    type: z.enum(['folder', 'request']),
    request: z.union([httpRequestSchema, grpcRequestSchema]).optional(),
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
