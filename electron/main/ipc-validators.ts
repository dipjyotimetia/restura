import { z } from 'zod';

// ===========================
// Shared Size Constants
// ===========================

export const MAX_HTTP_BODY_BYTES = 50 * 1024 * 1024;
export const MAX_PROTO_CONTENT_BYTES = 1024 * 1024;

// ===========================
// HTTP Request Schemas
// ===========================

const ProxyConfigSchema = z.object({
  enabled: z.boolean(),
  type: z.enum(['http', 'https', 'socks4', 'socks5', 'pac']),
  host: z.string(),
  port: z.number().int().positive(),
  pacUrl: z.string().url('Invalid PAC URL').optional(),
  auth: z
    .object({
      username: z.string(),
      password: z.string(),
    })
    .optional(),
});

const ClientCertSchema = z.object({
  pfx: z.string().optional(),        // base64-encoded PFX/PKCS12
  cert: z.string().optional(),       // PEM certificate string
  key: z.string().optional(),        // PEM private key string
  passphrase: z.string().optional(), // passphrase for pfx or encrypted key
});

const CaCertSchema = z.object({
  pem: z.string().min(1),
});

// Sign-at-wire auth. Only `aws-signature` is acted on by the shared core;
// other types pass through and are no-ops in the proxy (they were already
// applied by the renderer's applyAuthHeaders before the IPC).
const AuthConfigSchema = z.object({
  type: z.enum(['none', 'basic', 'bearer', 'api-key', 'oauth2', 'digest', 'aws-signature']),
  awsSignature: z
    .object({
      accessKey: z.string(),
      secretKey: z.string(),
      region: z.string(),
      service: z.string(),
    })
    .optional(),
});

export const HttpRequestConfigSchema = z.object({
  method: z.string(),
  url: z.string().url('Invalid URL format'),
  headers: z.record(z.string(), z.string()).optional(),
  params: z.record(z.string(), z.string()).optional(),
  data: z.string().max(MAX_HTTP_BODY_BYTES, 'Request body exceeds 50MB limit').optional(),
  timeout: z.number().int().positive().optional(),
  maxRedirects: z.number().int().min(0).optional(),
  proxy: ProxyConfigSchema.optional(),
  verifySsl: z.boolean().optional(),
  clientCert: ClientCertSchema.optional(),
  caCert: CaCertSchema.optional(),
  auth: AuthConfigSchema.optional(),
});

export type HttpRequestConfig = z.infer<typeof HttpRequestConfigSchema>;

// ===========================
// gRPC Request Schemas
// ===========================

export const GrpcRequestConfigSchema = z.object({
  id: z.string().optional(),
  url: z.string().url('Invalid gRPC URL'),
  service: z.string().min(1, 'Service name is required'),
  method: z.string().min(1, 'Method name is required'),
  methodType: z.enum(['unary', 'server-streaming', 'client-streaming', 'bidirectional-streaming']),
  metadata: z.record(z.string(), z.string()),
  message: z.unknown(),
  protoContent: z.string().min(1, 'Proto content is required').max(MAX_PROTO_CONTENT_BYTES, 'Proto content exceeds 1MB limit'),
  protoFileName: z.string().min(1, 'Proto file name is required'),
  useCompression: z.boolean().optional(),
});

export type GrpcRequestConfig = z.infer<typeof GrpcRequestConfigSchema>;

// ===========================
// File Operations Schemas
// ===========================

export const DialogOptionsSchema = z.object({
  filters: z
    .array(
      z.object({
        name: z.string(),
        extensions: z.array(z.string()),
      })
    )
    .optional(),
  defaultPath: z.string().optional(),
});

export const FilePathSchema = z.string().min(1, 'File path is required').max(4096, 'File path too long');

export const FileContentSchema = z.string().max(50 * 1024 * 1024, 'File content exceeds 50MB limit');

// Schema for fs:writeFile which takes both filePath and content
export const WriteFileSchema = z.tuple([FilePathSchema, FileContentSchema]);

export const AppPathNameSchema = z.enum([
  'home',
  'appData',
  'userData',
  'cache',
  'temp',
  'exe',
  'module',
  'desktop',
  'documents',
  'downloads',
  'music',
  'pictures',
  'videos',
  'recent',
  'logs',
  'crashDumps',
]);

export const SAFE_OPEN_PROTOCOLS = ['http:', 'https:', 'mailto:'] as const;

export const ShellUrlSchema = z.string().url('Invalid URL format').refine(
  (url) => (SAFE_OPEN_PROTOCOLS as readonly string[]).includes(new URL(url).protocol),
  { message: 'Only http, https, and mailto URLs are allowed' }
);

// ===========================
// Notification Schemas
// ===========================

export const NotificationOptionsSchema = z.object({
  title: z.string().min(1, 'Title is required').max(256, 'Title too long'),
  body: z.string().min(1, 'Body is required').max(1024, 'Body too long'),
  silent: z.boolean().optional(),
  icon: z.string().optional(),
  urgency: z.enum(['normal', 'critical', 'low']).optional(),
});

export const NotificationVersionSchema = z.string().regex(/^\d+\.\d+\.\d+/, 'Invalid version format');

export const NotificationMessageSchema = z.string().min(1, 'Message is required').max(1024, 'Message too long');

export const NotificationRequestCompleteSchema = z.object({
  status: z.number().int(),
  time: z.number(),
  url: z.string().url('Invalid URL format'),
});

// ===========================
// gRPC Reflection Schemas
// ===========================

export const ReflectionIpcConfigSchema = z.object({
  url: z.string().url('Invalid URL format'),
  reflectionService: z.string().min(1, 'Reflection service name is required'),
  request: z.record(z.string(), z.unknown()),
  timeout: z.number().int().positive().optional(),
});

export type ReflectionIpcConfig = z.infer<typeof ReflectionIpcConfigSchema>;

// ===========================
// gRPC Stream Schemas
// ===========================

export const GrpcStreamRequestIdSchema = z.string().min(1, 'Request ID is required');

export const GrpcStreamMessageSchema = z.unknown(); // Allow any message structure

// Schema for grpc:send-message which takes both requestId and message
export const GrpcSendMessageSchema = z.tuple([GrpcStreamRequestIdSchema, GrpcStreamMessageSchema]);

// ===========================
// WebSocket Schemas
// ===========================

export const WsConnectionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/, 'Connection ID must contain only alphanumeric characters, underscores, or hyphens');

// Hop-by-hop and sensitive headers that must not be forwarded to arbitrary WebSocket servers
const WS_HEADER_DENYLIST = new Set([
  'host', 'origin', 'sec-websocket-key', 'sec-websocket-version', 'upgrade',
  'connection', 'transfer-encoding', 'te', 'proxy-authorization', 'proxy-connection',
]);

export const WsConnectSchema = z.object({
  connectionId: WsConnectionIdSchema,
  url: z.string().url('Invalid WebSocket URL').refine(
    (url) => ['ws:', 'wss:'].includes(new URL(url).protocol),
    { message: 'Only ws: and wss: WebSocket URLs are allowed' }
  ),
  headers: z
    .record(z.string(), z.string())
    .refine(
      (headers) => !Object.keys(headers).some((k) => WS_HEADER_DENYLIST.has(k.toLowerCase())),
      { message: `Headers must not include hop-by-hop or security-sensitive fields: ${[...WS_HEADER_DENYLIST].join(', ')}` }
    )
    .optional(),
  protocols: z.array(z.string()).optional(),
});

export const WsSendSchema = z.object({
  connectionId: WsConnectionIdSchema,
  message: z.string().max(1024 * 1024, 'Message exceeds 1MB limit'),
  binary: z.boolean().optional(),
});

export const WsDisconnectSchema = z.object({
  connectionId: WsConnectionIdSchema,
});

export type WsConnectConfig = z.infer<typeof WsConnectSchema>;
export type WsSendConfig = z.infer<typeof WsSendSchema>;
export type WsDisconnectConfig = z.infer<typeof WsDisconnectSchema>;

// ===========================
// SSE Schemas
// ===========================

// Header denylist for streaming HTTP requests we issue from Node.
// These are either hop-by-hop (forbidden by spec to forward) or sensitive
// security context that the user shouldn't be able to inject.
const STREAMING_HEADER_DENYLIST = new Set([
  'host', 'origin', 'connection', 'upgrade', 'transfer-encoding', 'te',
  'proxy-authorization', 'proxy-connection', 'cookie',
]);

export const SseConnectionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/, 'Connection ID must contain only alphanumeric characters, underscores, or hyphens');

export const SseConnectSchema = z.object({
  connectionId: SseConnectionIdSchema,
  url: z.string().url('Invalid SSE URL').refine(
    (url) => ['http:', 'https:'].includes(new URL(url).protocol),
    { message: 'Only http: and https: URLs are allowed' }
  ),
  headers: z
    .record(z.string(), z.string())
    .refine(
      (headers) => !Object.keys(headers).some((k) => STREAMING_HEADER_DENYLIST.has(k.toLowerCase())),
      { message: `Headers must not include hop-by-hop or security-sensitive fields: ${[...STREAMING_HEADER_DENYLIST].join(', ')}` }
    )
    .optional(),
});

export const SseDisconnectSchema = z.object({
  connectionId: SseConnectionIdSchema,
});

export type SseConnectConfig = z.infer<typeof SseConnectSchema>;
export type SseDisconnectConfig = z.infer<typeof SseDisconnectSchema>;

// ===========================
// MCP Schemas
// ===========================

export const McpConnectionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/, 'Connection ID must contain only alphanumeric characters, underscores, or hyphens');

export const McpConnectSchema = z.object({
  connectionId: McpConnectionIdSchema,
  url: z.string().url('Invalid MCP server URL').refine(
    (url) => ['http:', 'https:'].includes(new URL(url).protocol),
    { message: 'Only http: and https: URLs are allowed' }
  ),
  transport: z.enum(['streamable-http', 'http-sse']),
  headers: z
    .record(z.string(), z.string())
    .refine(
      (headers) => !Object.keys(headers).some((k) => STREAMING_HEADER_DENYLIST.has(k.toLowerCase())),
      { message: `Headers must not include hop-by-hop or security-sensitive fields: ${[...STREAMING_HEADER_DENYLIST].join(', ')}` }
    )
    .optional(),
});

// JSON-RPC method names for MCP. We don't lock down to a fixed enum since the
// spec evolves — instead we validate shape (non-empty string) and forward.
export const McpRequestSchema = z.object({
  connectionId: McpConnectionIdSchema,
  method: z.string().min(1).max(256),
  params: z.unknown().optional(),
  /** Caller-supplied request id (string or number per JSON-RPC spec) */
  requestId: z.union([z.string(), z.number()]).optional(),
  timeout: z.number().int().positive().max(300_000).optional(),
});

export const McpDisconnectSchema = z.object({
  connectionId: McpConnectionIdSchema,
});

export type McpConnectConfig = z.infer<typeof McpConnectSchema>;
export type McpRequestConfig = z.infer<typeof McpRequestSchema>;
export type McpDisconnectConfig = z.infer<typeof McpDisconnectSchema>;

// ===========================
// Store Schemas
// ===========================

// electron-store uses dot-notation for nested access (e.g. "a.b" reads obj.a.b).
// Dots and colons are allowed here intentionally — callers must use flat keys only
// to avoid unintended nesting side-effects.
export const StoreKeySchema = z
  .string()
  .min(1, 'Key is required')
  .max(256, 'Key too long')
  .regex(/^[a-zA-Z0-9._:-]+$/, 'Key must contain only alphanumeric characters, dots, underscores, colons, or hyphens');

export const StoreValueSchema = z.string().max(1024 * 1024, 'Value exceeds 1MB limit');

// ===========================
// Log Schemas
// ===========================

export const LogHistoryLimitSchema = z.number().int().positive().max(1000).optional();

// ===========================
// Validation Helper
// ===========================

/**
 * Validates IPC input using a Zod schema
 * Throws a descriptive error if validation fails
 */
export function validateIpcInput<T>(schema: z.ZodSchema<T>, data: unknown, channel: string): T {
  try {
    return schema.parse(data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.issues.map((err) => `${err.path.join('.')}: ${err.message}`).join(', ');

      console.error(`[IPC Validation Error] Channel: ${channel}`, {
        issues: error.issues,
        receivedData: data,
      });

      throw new Error(`Invalid IPC payload for ${channel}: ${errorMessages}`);
    }
    throw error;
  }
}

/**
 * Creates a validated IPC handler with automatic error handling
 */
export function createValidatedHandler<TInput, TOutput>(
  channel: string,
  schema: z.ZodSchema<TInput>,
  handler: (input: TInput) => Promise<TOutput> | TOutput
): (_event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<TOutput> {
  return async (_event, ...args) => {
    // For handlers with single argument, validate it directly
    // For handlers with multiple arguments, validate the first one
    const input = args.length === 1 ? args[0] : args;
    const validated = validateIpcInput(schema, input, channel);
    return handler(validated as TInput);
  };
}

/**
 * Creates a validated IPC listener (for ipcMain.on) with automatic error handling
 */
export function createValidatedListener<TInput>(
  channel: string,
  schema: z.ZodSchema<TInput>,
  handler: (event: Electron.IpcMainEvent, input: TInput) => void
): (event: Electron.IpcMainEvent, ...args: unknown[]) => void {
  return (event, ...args) => {
    try {
      const input = args.length === 1 ? args[0] : args;
      const validated = validateIpcInput(schema, input, channel);
      handler(event, validated as TInput);
    } catch (error) {
      console.error(`[IPC Listener Error] Channel: ${channel}`, error);
      // For .on() handlers, we can't return errors, so we just log
    }
  };
}
