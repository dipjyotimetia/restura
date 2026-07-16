import { FormFieldSchema } from '@shared/protocol/proxy-schema';
import { protocolSecretValueSchema } from '@shared/protocol/secret-value-schema';
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
  pacUrl: z.url('Invalid PAC URL').optional(),
  auth: z
    .object({
      username: z.string(),
      // SecretValue per ADR-0007 — accepts a plain string (legacy / inline),
      // an inline SecretRef, or a handle resolved main-side at wire time.
      password: protocolSecretValueSchema,
    })
    .optional(),
});

const ClientCertSchema = z.object({
  pfx: z.string().optional(), // base64-encoded PFX/PKCS12
  cert: z.string().optional(), // PEM certificate string
  key: z.string().optional(), // PEM private key string
  // passphrase for pfx or encrypted key — SecretValue per ADR-0007.
  passphrase: protocolSecretValueSchema.optional(),
});

const CaCertSchema = z.object({
  pem: z.string().min(1),
});

// The renderer mirrors the complete Settings execution subset to the Electron
// main process. Keep this schema here, at the trusted IPC boundary, so a
// compromised renderer cannot smuggle an unsupported proxy mode or malformed
// certificate/secret material into a future protocol adapter.
const ExecutionProxySchema = z
  .object({
    enabled: z.boolean(),
    type: z.enum(['none', 'http', 'https', 'socks4', 'socks5']),
    host: z.string().max(253),
    port: z.number().int().min(1).max(65535),
    bypassList: z.array(z.string().min(1).max(253)).max(100),
    auth: z
      .object({
        username: z.string().max(256),
        password: protocolSecretValueSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((proxy, ctx) => {
    if (proxy.enabled && proxy.type === 'none') {
      ctx.addIssue({
        code: 'custom',
        path: ['type'],
        message: 'Enabled proxy requires a supported type',
      });
    }
    if (proxy.enabled && !proxy.host.trim()) {
      ctx.addIssue({ code: 'custom', path: ['host'], message: 'Enabled proxy requires a host' });
    }
  });

const ExecutionClientCertSchema = z
  .object({
    format: z.enum(['pfx', 'pem']),
    pfx: z
      .string()
      .max(1024 * 1024)
      .optional(),
    cert: z
      .string()
      .max(1024 * 1024)
      .optional(),
    key: z
      .string()
      .max(1024 * 1024)
      .optional(),
    passphrase: protocolSecretValueSchema.optional(),
  })
  .strict()
  .superRefine((cert, ctx) => {
    if (cert.format === 'pfx' && !cert.pfx) {
      ctx.addIssue({ code: 'custom', path: ['pfx'], message: 'PFX certificates require pfx data' });
    }
    if (cert.format === 'pem' && (!cert.cert || !cert.key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['cert'],
        message: 'PEM certificates require cert and key data',
      });
    }
  });

const ExecutionCaCertSchema = z
  .object({
    pem: z
      .string()
      .min(1)
      .max(1024 * 1024),
  })
  .strict();

const HostClientCertSchema = z
  .object({
    id: z.string().min(1).max(128),
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535).optional(),
    cert: ExecutionClientCertSchema,
  })
  .strict();

const HostCaCertSchema = z
  .object({
    id: z.string().min(1).max(128),
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535).optional(),
    pem: z
      .string()
      .min(1)
      .max(1024 * 1024),
  })
  .strict();

/** Full renderer settings subset that can affect outbound desktop execution. */
export const ExecutionPolicySchema = z
  .object({
    allowLocalhost: z.boolean(),
    allowPrivateIPs: z.boolean(),
    proxy: ExecutionProxySchema,
    defaultTimeout: z.number().int().min(1).max(600_000),
    verifySsl: z.boolean(),
    clientCert: ExecutionClientCertSchema.optional(),
    caCert: ExecutionCaCertSchema.optional(),
    clientCertificates: z.array(HostClientCertSchema).max(100),
    caCertificates: z.array(HostCaCertSchema).max(100),
    serverCipherOrder: z.boolean().optional(),
    minTlsVersion: z.enum(['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3']).optional(),
    cipherSuites: z
      .string()
      .max(16 * 1024)
      .optional(),
  })
  .strict();

// TLS material for gRPC over `https://` / `grpcs://`. Mirrors HTTP's
// verifySsl / clientCert / caCert so a self-signed, private-CA, or mTLS gRPC
// server can be reached from desktop. Resolved per-host in the renderer from
// the same certificate-override settings HTTP uses, then mapped onto Node's
// http2/tls options by the connect-node transport builder (grpc-connect.ts).
const GrpcTlsFields = {
  verifySsl: z.boolean().optional(),
  clientCert: ClientCertSchema.optional(),
  caCert: CaCertSchema.optional(),
} as const;

// Auth carried across the IPC boundary. The shared core's `applyAuth` signs
// the sign-at-wire types (aws-signature, oauth1, wsse) with a resolver; the
// Electron handler also resolves+applies non-sign-at-wire types (basic, bearer,
// api-key, oauth2) main-side when a handle is present (renderer cannot read
// handle plaintext). Sensitive fields are SecretValue per ADR-0007.
const AuthConfigSchema = z.object({
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
      password: protocolSecretValueSchema,
    })
    .optional(),
  bearer: z
    .object({
      token: protocolSecretValueSchema,
    })
    .optional(),
  apiKey: z
    .object({
      key: z.string(),
      value: protocolSecretValueSchema,
      in: z.enum(['header', 'query']),
    })
    .optional(),
  oauth2: z
    .object({
      accessToken: protocolSecretValueSchema,
      tokenType: z.string().optional(),
      refreshToken: protocolSecretValueSchema.optional(),
      expiresAt: z.number().optional(),
      scopes: z.array(z.string()).optional(),
      grantType: z
        .enum(['authorization_code', 'client_credentials', 'password', 'device_code'])
        .optional(),
      clientId: z.string().optional(),
      clientSecret: protocolSecretValueSchema.optional(),
      authorizationUrl: z.string().optional(),
      tokenUrl: z.string().optional(),
      deviceAuthorizationUrl: z.string().optional(),
      scope: z.string().optional(),
      redirectUri: z.string().optional(),
      username: z.string().optional(),
      password: protocolSecretValueSchema.optional(),
    })
    .optional(),
  digest: z
    .object({
      username: z.string(),
      password: protocolSecretValueSchema,
    })
    .optional(),
  awsSignature: z
    .object({
      accessKey: z.string(),
      secretKey: protocolSecretValueSchema,
      region: z.string(),
      service: z.string(),
    })
    .optional(),
  oauth1: z
    .object({
      consumerKey: z.string(),
      consumerSecret: protocolSecretValueSchema,
      accessToken: protocolSecretValueSchema.optional(),
      accessTokenSecret: protocolSecretValueSchema.optional(),
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
      password: protocolSecretValueSchema,
      domain: z.string().optional(),
      workstation: z.string().optional(),
    })
    .optional(),
  wsse: z
    .object({
      username: z.string(),
      password: protocolSecretValueSchema,
      passwordType: z.enum(['PasswordDigest', 'PasswordText']).optional(),
    })
    .optional(),
});

export const HttpRequestConfigSchema = z.object({
  requestId: z.uuid(),
  method: z.string(),
  url: z.url('Invalid URL format'),
  headers: z.record(z.string(), z.string()).optional(),
  params: z.record(z.string(), z.string()).optional(),
  data: z.string().max(MAX_HTTP_BODY_BYTES, 'Request body exceeds 50MB limit').optional(),
  // Structured body: `bodyType` drives the shared body-builder (binary base64 in
  // `data`, multipart fields in `formData`). Absent bodyType falls back to the
  // legacy raw-when-data behaviour in the handler.
  bodyType: z
    .enum(['none', 'json', 'text', 'raw', 'form-urlencoded', 'form-data', 'binary'])
    .optional(),
  formData: z.array(FormFieldSchema).optional(),
  timeout: z.number().int().positive().optional(),
  maxRedirects: z.number().int().min(0).optional(),
  proxy: ProxyConfigSchema.optional(),
  verifySsl: z.boolean().optional(),
  clientCert: ClientCertSchema.optional(),
  caCert: CaCertSchema.optional(),
  auth: AuthConfigSchema.optional(),
  // Redirect policy + URL handling (cross-platform; honoured in shared/protocol)
  followOriginalMethod: z.boolean().optional(),
  followAuthHeader: z.boolean().optional(),
  stripReferer: z.boolean().optional(),
  encodeUrlAutomatically: z.boolean().optional(),
  // TLS knobs (desktop-only; honoured by buildConnectOptions / createSocksDispatcher)
  serverCipherOrder: z.boolean().optional(),
  minTlsVersion: z.enum(['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3']).optional(),
  cipherSuites: z.string().optional(),
});

export type ValidatedHttpRequestConfig = z.infer<typeof HttpRequestConfigSchema>;

export const HttpCancelSchema = z
  .object({
    requestId: z.uuid(),
  })
  .strict();

// ===========================
// gRPC Request Schemas
// ===========================

export const GrpcRequestConfigSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/, 'id must be alphanumeric with dashes/underscores')
      .max(64, 'id too long')
      .optional(),
    url: z.url('Invalid gRPC URL'),
    service: z.string().min(1, 'Service name is required'),
    method: z.string().min(1, 'Method name is required'),
    methodType: z.enum([
      'unary',
      'server-streaming',
      'client-streaming',
      'bidirectional-streaming',
    ]),
    metadata: z.record(z.string(), z.string()),
    message: z.unknown(),
    // Proto source — EITHER hand-written `.proto` text OR `descriptors` (below).
    // Optional individually; the refine enforces that at least one is present.
    protoContent: z
      .string()
      .max(MAX_PROTO_CONTENT_BYTES, 'Proto content exceeds 1MB limit')
      .optional(),
    protoFileName: z.string().min(1, 'Proto file name is required').optional(),
    // Base64-encoded binary FileDescriptorProtos from server reflection (the
    // complete set incl. transitive deps). Preferred over `protoContent` for the
    // reflection path — built into a runtime registry via bufbuild so enums /
    // well-known types / maps / oneofs / cross-package refs survive (text
    // reconstruction dropped them). See shared/protocol/grpc-registry.
    descriptors: z
      .array(z.string().max(MAX_PROTO_CONTENT_BYTES, 'Descriptor too large'))
      .max(1024, 'Too many descriptors')
      .optional(),
    useCompression: z.boolean().optional(),
    // Per-call deadline in ms. Applied as the ConnectRPC `timeoutMs` call option
    // on unary and streaming invocations; omitted → no deadline. Capped at 10min.
    timeoutMs: z.number().int().positive().max(600_000).optional(),
    // Present only when a credential carries a SecretRef handle the renderer
    // cannot resolve (ADR-0007). The handler resolves it main-side via the OS
    // keychain and merges it into the metadata. Inline/plain creds are already
    // in `metadata`, so `auth` is omitted for them.
    auth: AuthConfigSchema.optional(),
    // TLS trust / mTLS material for https:// / grpcs:// (see GrpcTlsFields).
    ...GrpcTlsFields,
  })
  .refine((c) => Boolean(c.protoContent) || Boolean(c.descriptors?.length), {
    message: 'Either protoContent or descriptors is required',
    path: ['protoContent'],
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

export const FilePathSchema = z
  .string()
  .min(1, 'File path is required')
  .max(4096, 'File path too long');

export const FileContentSchema = z
  .string()
  .max(50 * 1024 * 1024, 'File content exceeds 50MB limit');

// Schema for fs:writeFile which takes both filePath and content
export const WriteFileSchema = z.tuple([FilePathSchema, FileContentSchema]);

// Keep in sync with ElectronAppAPI.getPath in electron/types/electron-api.ts —
// a name in one list but not the other either type-checks then fails at
// runtime, or works at runtime but is untyped.
export const AppPathNameSchema = z.enum([
  'home',
  'appData',
  'userData',
  'sessionData',
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

export const ShellUrlSchema = z
  .string()
  .url('Invalid URL format')
  .refine((url) => (SAFE_OPEN_PROTOCOLS as readonly string[]).includes(new URL(url).protocol), {
    message: 'Only http, https, and mailto URLs are allowed',
  });

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

export const NotificationVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+/, 'Invalid version format');

export const NotificationMessageSchema = z
  .string()
  .min(1, 'Message is required')
  .max(1024, 'Message too long');

export const NotificationRequestCompleteSchema = z.object({
  status: z.number().int(),
  time: z.number(),
  url: z.url('Invalid URL format'),
});

// ===========================
// Auto-updater Schemas
// ===========================

export const UpdaterConfigSchema = z.object({
  autoDownload: z.boolean(),
  channel: z.enum(['stable', 'beta']),
});

export type UpdaterConfig = z.infer<typeof UpdaterConfigSchema>;

// ===========================
// gRPC Reflection Schemas
// ===========================

export const ReflectionIpcConfigSchema = z.object({
  url: z.url('Invalid URL format'),
  reflectionService: z.string().min(1, 'Reflection service name is required'),
  request: z.record(z.string(), z.unknown()),
  timeout: z.number().int().positive().optional(),
  // Reflection dials the same TLS endpoint as the call, so it needs the same
  // trust material (otherwise Discover silently fails against a self-signed /
  // private-CA / mTLS server while the call would have worked).
  ...GrpcTlsFields,
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
// Connection-based protocols (WebSocket / Socket.IO / SSE / MCP / Kafka / MQTT)
// ===========================

// Renderer-supplied connection id: a uuid-ish token used to route per-connection
// IPC events. Shared by every streaming protocol so the validation (and its
// error message) stays identical across them.
export const ConnectionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[a-zA-Z0-9_-]+$/,
    'Connection ID must contain only alphanumeric characters, underscores, or hyphens'
  );

// ===========================
// WebSocket Schemas
// ===========================

export const WsConnectionIdSchema = ConnectionIdSchema;

// Hop-by-hop and sensitive headers that must not be forwarded to arbitrary WebSocket servers
const WS_HEADER_DENYLIST = new Set([
  'host',
  'origin',
  'sec-websocket-key',
  'sec-websocket-version',
  'upgrade',
  'connection',
  'transfer-encoding',
  'te',
  'proxy-authorization',
  'proxy-connection',
]);

export const WsConnectSchema = z.object({
  connectionId: WsConnectionIdSchema,
  url: z
    .string()
    .url('Invalid WebSocket URL')
    .refine((url) => ['ws:', 'wss:'].includes(new URL(url).protocol), {
      message: 'Only ws: and wss: WebSocket URLs are allowed',
    }),
  headers: z
    .record(z.string(), z.string())
    .refine(
      (headers) => !Object.keys(headers).some((k) => WS_HEADER_DENYLIST.has(k.toLowerCase())),
      {
        message: `Headers must not include hop-by-hop or security-sensitive fields: ${[...WS_HEADER_DENYLIST].join(', ')}`,
      }
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
// Socket.IO Schemas
// ===========================

// Hop-by-hop and security-sensitive headers that must not be forwarded to
// arbitrary Socket.IO servers via extraHeaders.
const SOCKETIO_HEADER_DENYLIST = new Set([
  'host',
  'origin',
  'connection',
  'upgrade',
  'transfer-encoding',
  'te',
  'proxy-authorization',
  'proxy-connection',
  'sec-websocket-key',
  'sec-websocket-version',
]);

export const SocketIoConnectionIdSchema = ConnectionIdSchema;

export const SocketIoConnectSchema = z.object({
  connectionId: SocketIoConnectionIdSchema,
  url: z
    .string()
    .url('Invalid Socket.IO URL')
    .refine((url) => ['http:', 'https:', 'ws:', 'wss:'].includes(new URL(url).protocol), {
      message: 'Only http(s) and ws(s) Socket.IO URLs are allowed',
    }),
  namespace: z
    .string()
    .regex(/^\/[A-Za-z0-9/_-]*$/, 'Namespace must start with / and contain only safe characters')
    .optional(),
  path: z.string().startsWith('/', 'Path must start with /').optional(),
  auth: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  query: z.record(z.string(), z.string()).optional(),
  extraHeaders: z
    .record(z.string(), z.string())
    .refine(
      (headers) => !Object.keys(headers).some((k) => SOCKETIO_HEADER_DENYLIST.has(k.toLowerCase())),
      {
        message: `Headers must not include hop-by-hop or security-sensitive fields: ${[...SOCKETIO_HEADER_DENYLIST].join(', ')}`,
      }
    )
    .optional(),
  transports: z
    .array(z.enum(['websocket', 'polling']))
    .min(1)
    .optional(),
  reconnection: z.boolean().optional(),
  reconnectionAttempts: z.number().int().nonnegative().max(100).optional(),
  reconnectionDelay: z.number().int().nonnegative().max(60_000).optional(),
  timeout: z.number().int().positive().max(120_000).optional(),
  forceNew: z.boolean().optional(),
});

export const SocketIoEmitSchema = z.object({
  connectionId: SocketIoConnectionIdSchema,
  eventName: z.string().min(1).max(256),
  args: z.array(z.unknown()).max(32),
  ackId: z.string().min(1).max(128).optional(),
  ackTimeoutMs: z.number().int().positive().max(60_000).optional(),
});

export const SocketIoDisconnectSchema = z.object({
  connectionId: SocketIoConnectionIdSchema,
});

export type SocketIoConnectConfig = z.infer<typeof SocketIoConnectSchema>;
export type SocketIoEmitConfig = z.infer<typeof SocketIoEmitSchema>;
export type SocketIoDisconnectConfig = z.infer<typeof SocketIoDisconnectSchema>;

// ===========================
// SSE Schemas
// ===========================

// Header denylist for streaming HTTP requests we issue from Node.
// These are either hop-by-hop (forbidden by spec to forward) or sensitive
// security context that the user shouldn't be able to inject.
const STREAMING_HEADER_DENYLIST = new Set([
  'host',
  'origin',
  'connection',
  'upgrade',
  'transfer-encoding',
  'te',
  'proxy-authorization',
  'proxy-connection',
  'cookie',
]);

export const SseConnectionIdSchema = ConnectionIdSchema;

export const SseConnectSchema = z.object({
  connectionId: SseConnectionIdSchema,
  url: z
    .string()
    .url('Invalid SSE URL')
    .refine((url) => ['http:', 'https:'].includes(new URL(url).protocol), {
      message: 'Only http: and https: URLs are allowed',
    }),
  headers: z
    .record(z.string(), z.string())
    .refine(
      (headers) =>
        !Object.keys(headers).some((k) => STREAMING_HEADER_DENYLIST.has(k.toLowerCase())),
      {
        message: `Headers must not include hop-by-hop or security-sensitive fields: ${[...STREAMING_HEADER_DENYLIST].join(', ')}`,
      }
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

export const McpConnectionIdSchema = ConnectionIdSchema;

export const McpConnectSchema = z.object({
  connectionId: McpConnectionIdSchema,
  url: z
    .string()
    .url('Invalid MCP server URL')
    .refine((url) => ['http:', 'https:'].includes(new URL(url).protocol), {
      message: 'Only http: and https: URLs are allowed',
    }),
  transport: z.enum(['streamable-http', 'http-sse']),
  headers: z
    .record(z.string(), z.string())
    .refine(
      (headers) =>
        !Object.keys(headers).some((k) => STREAMING_HEADER_DENYLIST.has(k.toLowerCase())),
      {
        message: `Headers must not include hop-by-hop or security-sensitive fields: ${[...STREAMING_HEADER_DENYLIST].join(', ')}`,
      }
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
