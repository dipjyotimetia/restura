import { z } from 'zod';
import { protocolSecretValueSchema } from '@shared/protocol/secret-value-schema';
import { FormFieldSchema } from '@shared/protocol/proxy-schema';
import { createLogger } from '../../../src/lib/shared/logger';

const log = createLogger('ipc');

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

export type HttpRequestConfig = z.infer<typeof HttpRequestConfigSchema>;

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

// ===========================
// Kafka Schemas
// ===========================

export const KafkaConnectionIdSchema = ConnectionIdSchema;

// host:port — loose syntactic check; real reachability is enforced by the
// Kafka client when it dials the broker. We cap length and forbid junk so the
// schema rejects obviously bad input early.
const KafkaBrokerSchema = z
  .string()
  .min(3)
  .max(253)
  .regex(
    /^[a-zA-Z0-9.-]+:\d{1,5}$/,
    'Broker must be host:port (alphanumeric host, numeric port 1-65535)'
  );

const KafkaSaslMechanismSchema = z.enum(['PLAIN', 'SCRAM-SHA-256', 'SCRAM-SHA-512']);

const KafkaSaslSchema = z.object({
  mechanism: KafkaSaslMechanismSchema,
  username: z.string().min(1).max(256),
  password: z.string().min(1).max(1024),
});

const KafkaTlsSchema = z.object({
  ca: z
    .string()
    .max(64 * 1024)
    .optional(),
  cert: z
    .string()
    .max(64 * 1024)
    .optional(),
  key: z
    .string()
    .max(64 * 1024)
    .optional(),
  passphrase: z.string().max(1024).optional(),
  rejectUnauthorized: z.boolean().optional(),
});

const KafkaAuthSchema = z.discriminatedUnion('securityProtocol', [
  z.object({ securityProtocol: z.literal('PLAINTEXT') }),
  z.object({
    securityProtocol: z.literal('SASL_PLAINTEXT'),
    sasl: KafkaSaslSchema,
  }),
  z.object({
    securityProtocol: z.literal('SASL_SSL'),
    sasl: KafkaSaslSchema,
    tls: KafkaTlsSchema.optional(),
  }),
  z.object({
    securityProtocol: z.literal('SSL'),
    tls: KafkaTlsSchema,
  }),
]);

export const KafkaCompressionSchema = z.enum(['none', 'gzip', 'snappy', 'lz4', 'zstd']);
export const KafkaAcksSchema = z.union([z.literal(0), z.literal(1), z.literal(-1)]);

// Confluent Schema Registry. `url` is SSRF-guarded at connect; auth holds the
// already-resolved plaintext (kafkaManager resolves secret sentinels first).
const KafkaRegistrySchema = z.object({
  url: z.url('Invalid Schema Registry URL').max(2048),
  auth: z
    .object({
      username: z.string().max(256).optional(),
      password: z.string().max(1024).optional(),
      token: z.string().max(4096).optional(),
    })
    .optional(),
});

export const KafkaConnectSchema = z.object({
  connectionId: KafkaConnectionIdSchema,
  clientId: z.string().min(1).max(256),
  bootstrapBrokers: z.array(KafkaBrokerSchema).min(1).max(32),
  auth: KafkaAuthSchema,
  // Enable the idempotent producer (exactly-once-per-partition delivery dedup).
  // An idempotent producer REQUIRES acks=all(-1); the produce handler forces
  // that override when this is set, and the UI locks the acks picker to -1.
  idempotent: z.boolean().optional(),
  registry: KafkaRegistrySchema.optional(),
});

// Topic naming rules per Kafka: max 249 chars, [a-zA-Z0-9._-]; we also forbid
// leading dot/dash for sanity.
const KafkaTopicSchema = z
  .string()
  .min(1)
  .max(249)
  .regex(
    /^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/,
    'Topic must start with [a-zA-Z0-9_] and contain only [a-zA-Z0-9._-]'
  );

// 10MB per-message ceiling — well above the typical Kafka 1MB default, but
// callers can lower it via broker config. Stops a malformed renderer from
// queueing a 1GB string over IPC.
const KAFKA_MAX_VALUE_BYTES = 10 * 1024 * 1024;
const KAFKA_MAX_KEY_BYTES = 1 * 1024 * 1024;

export const KafkaProduceSchema = z.object({
  connectionId: KafkaConnectionIdSchema,
  topic: KafkaTopicSchema,
  key: z.string().max(KAFKA_MAX_KEY_BYTES).optional(),
  value: z.string().max(KAFKA_MAX_VALUE_BYTES),
  headers: z.record(z.string().min(1).max(256), z.string().max(64 * 1024)).optional(),
  partition: z.number().int().nonnegative().max(2_147_483_647).optional(),
  acks: KafkaAcksSchema,
  compression: KafkaCompressionSchema.optional(),
  // Confluent Schema Registry schema ids. When set (registry connections only),
  // that field is parsed as JSON and encoded with the given schema. Key and value
  // are independent.
  valueSchemaId: z.number().int().positive().optional(),
  keySchemaId: z.number().int().positive().optional(),
});

// Per-partition starting offset for MANUAL consume mode. `offset` is a numeric
// string because the underlying lib uses bigint offsets (TopicWithPartitionAndOffset)
// — a string avoids JS Number precision loss past 2^53 and bigint/IPC friction.
const KafkaPartitionOffsetSchema = z.object({
  topic: KafkaTopicSchema,
  partition: z.number().int().nonnegative().max(2_147_483_647),
  offset: z.string().min(1).max(20).regex(/^\d+$/, 'Offset must be a non-negative integer string'),
});

// Consumer-group id — reused by subscribe and the group admin ops.
const KafkaGroupIdSchema = z.string().min(1).max(256);

export const KafkaSubscribeSchema = z.object({
  connectionId: KafkaConnectionIdSchema,
  groupId: KafkaGroupIdSchema,
  topics: z.array(KafkaTopicSchema).min(1).max(50),
  // Start position. 'latest'/'earliest' map to the lib's stream modes;
  // 'manual' seeks to the explicit per-partition `offsets` below; 'timestamp'
  // resolves each partition's first offset at/after `timestamp` (epoch ms) and
  // then seeks there via the MANUAL path. `fromBeginning` is kept for back-compat
  // and used only when `mode` is omitted.
  fromBeginning: z.boolean(),
  mode: z.enum(['latest', 'earliest', 'manual', 'timestamp']).optional(),
  offsets: z.array(KafkaPartitionOffsetSchema).min(1).max(200).optional(),
  // Epoch-millis as a numeric string (bigint at the wire). Required when
  // mode === 'timestamp'; ignored otherwise.
  timestamp: z
    .string()
    .min(1)
    .max(20)
    .regex(/^\d+$/, 'Timestamp must be a non-negative integer string (epoch ms)')
    .optional(),
});

export const KafkaUnsubscribeSchema = z.object({
  connectionId: KafkaConnectionIdSchema,
});

export const KafkaDisconnectSchema = z.object({
  connectionId: KafkaConnectionIdSchema,
});

// ---------------------------------------------------------------------------
// Kafka Admin (topic + consumer-group management). Each op constructs a
// short-lived Admin client from the connection's already-validated clientOptions
// (auth/TLS reused) and closes it in a finally.
// ---------------------------------------------------------------------------

export const KafkaListTopicsSchema = z.object({
  connectionId: KafkaConnectionIdSchema,
});

export const KafkaCreateTopicSchema = z.object({
  connectionId: KafkaConnectionIdSchema,
  topic: KafkaTopicSchema,
  // Broker is the real authority on limits; these caps just reject obviously
  // bad input early.
  partitions: z.number().int().positive().max(10_000),
  replicationFactor: z.number().int().positive().max(16),
});

export const KafkaDeleteTopicSchema = z.object({
  connectionId: KafkaConnectionIdSchema,
  topic: KafkaTopicSchema,
});

export const KafkaListGroupsSchema = z.object({
  connectionId: KafkaConnectionIdSchema,
});

// Topic inspector: partition watermarks (earliest/latest) + topic config.
export const KafkaInspectTopicSchema = z.object({
  connectionId: KafkaConnectionIdSchema,
  topic: KafkaTopicSchema,
});

// Consumer-group inspector: members/state + committed offsets + computed lag.
export const KafkaInspectGroupSchema = z.object({
  connectionId: KafkaConnectionIdSchema,
  groupId: KafkaGroupIdSchema,
});

// Reset a consumer group's committed offsets for one topic. 'earliest'/'latest'
// resolve the target offsets broker-side; 'specific' takes explicit per-partition
// offsets (required in that case). Kafka rejects this unless the group is inactive.
export const KafkaResetGroupOffsetsSchema = z
  .object({
    connectionId: KafkaConnectionIdSchema,
    groupId: KafkaGroupIdSchema,
    topic: KafkaTopicSchema,
    to: z.enum(['earliest', 'latest', 'specific']),
    // Same per-partition offset shape as the MANUAL-seek spec, minus the topic
    // (the topic is a top-level field here).
    partitions: z
      .array(KafkaPartitionOffsetSchema.omit({ topic: true }))
      .min(1)
      .max(1000)
      .optional(),
  })
  .refine((v) => v.to !== 'specific' || (v.partitions?.length ?? 0) > 0, {
    message: "partitions (with offsets) are required when to === 'specific'",
    path: ['partitions'],
  });

export const KafkaDeleteGroupSchema = z.object({
  connectionId: KafkaConnectionIdSchema,
  groupId: KafkaGroupIdSchema,
});

export type KafkaConnectConfig = z.infer<typeof KafkaConnectSchema>;
export type KafkaProduceConfig = z.infer<typeof KafkaProduceSchema>;
export type KafkaSubscribeConfig = z.infer<typeof KafkaSubscribeSchema>;
export type KafkaUnsubscribeConfig = z.infer<typeof KafkaUnsubscribeSchema>;
export type KafkaDisconnectConfig = z.infer<typeof KafkaDisconnectSchema>;
export type KafkaListTopicsConfig = z.infer<typeof KafkaListTopicsSchema>;
export type KafkaCreateTopicConfig = z.infer<typeof KafkaCreateTopicSchema>;
export type KafkaDeleteTopicConfig = z.infer<typeof KafkaDeleteTopicSchema>;
export type KafkaListGroupsConfig = z.infer<typeof KafkaListGroupsSchema>;
export type KafkaInspectTopicConfig = z.infer<typeof KafkaInspectTopicSchema>;
export type KafkaInspectGroupConfig = z.infer<typeof KafkaInspectGroupSchema>;
export type KafkaResetGroupOffsetsConfig = z.infer<typeof KafkaResetGroupOffsetsSchema>;
export type KafkaDeleteGroupConfig = z.infer<typeof KafkaDeleteGroupSchema>;

// ===========================
// MQTT Schemas
// ===========================

export const MqttConnectionIdSchema = ConnectionIdSchema;

// Only mqtt:// (TCP) and mqtts:// (TLS) — raw-socket transports. ws://wss://
// are deliberately excluded: MQTT-over-WebSocket is not wired (desktop-only,
// raw-socket parity with Kafka).
const MqttBrokerUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (u) => {
      try {
        return ['mqtt:', 'mqtts:'].includes(new URL(u).protocol);
      } catch {
        return false;
      }
    },
    { message: 'Broker URL must be a valid mqtt:// or mqtts:// URL' }
  );

// MQTT topic length ceiling (spec allows up to 65535 UTF-8 bytes).
const MQTT_TOPIC_MAX = 65535;

// PUBLISH topics are concrete — wildcards (`+` / `#`) are illegal in a publish.
const MqttPublishTopicSchema = z
  .string()
  .min(1)
  .max(MQTT_TOPIC_MAX)
  .refine((t) => !t.includes('+') && !t.includes('#'), {
    message: 'Publish topic must not contain wildcards (+ or #)',
  });

// SUBSCRIBE filters allow wildcards: `+` matches exactly one level, `#` matches
// the rest and may appear only as the final level.
const MqttSubscribeFilterSchema = z
  .string()
  .min(1)
  .max(MQTT_TOPIC_MAX)
  .refine(
    (f) => {
      const levels = f.split('/');
      return levels.every((lvl, i) => {
        if (lvl === '#') return i === levels.length - 1;
        if (lvl.includes('#')) return false;
        if (lvl.includes('+') && lvl !== '+') return false;
        return true;
      });
    },
    { message: 'Invalid MQTT topic filter (+ matches one level; # only as the final level)' }
  );

const MqttQoSSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);

const MqttTlsSchema = z.object({
  ca: z
    .string()
    .max(64 * 1024)
    .optional(),
  cert: z
    .string()
    .max(64 * 1024)
    .optional(),
  key: z
    .string()
    .max(64 * 1024)
    .optional(),
  passphrase: z.string().max(1024).optional(),
  rejectUnauthorized: z.boolean().optional(),
});

const MqttLwtSchema = z.object({
  topic: MqttPublishTopicSchema,
  payload: z.string().max(256 * 1024),
  qos: MqttQoSSchema,
  retain: z.boolean(),
});

// 10MB per-message ceiling, matching Kafka's. Stops a malformed renderer from
// queueing a giant string over IPC.
const MQTT_MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;

export const MqttConnectSchema = z.object({
  connectionId: MqttConnectionIdSchema,
  brokerUrl: MqttBrokerUrlSchema,
  // 4 = MQTT 3.1.1, 5 = MQTT 5.0.
  protocolVersion: z.union([z.literal(4), z.literal(5)]),
  clientId: z.string().min(1).max(256),
  keepalive: z.number().int().min(0).max(65535),
  cleanStart: z.boolean(),
  connectTimeout: z.number().int().positive().max(300_000),
  autoReconnect: z.boolean(),
  username: z.string().max(256).optional(),
  password: z.string().max(1024).optional(),
  tls: MqttTlsSchema.optional(),
  lwt: MqttLwtSchema.optional(),
  sessionExpiryInterval: z.number().int().nonnegative().max(4_294_967_295).optional(),
});

export const MqttPublishSchema = z.object({
  connectionId: MqttConnectionIdSchema,
  topic: MqttPublishTopicSchema,
  payload: z.string().max(MQTT_MAX_PAYLOAD_BYTES),
  qos: MqttQoSSchema,
  retain: z.boolean(),
  // MQTT 5.0 extras — ignored by the broker on a v3.1.1 connection.
  userProperties: z
    .record(z.string().max(256), z.union([z.string(), z.array(z.string())]))
    .optional(),
  messageExpiryInterval: z.number().int().nonnegative().max(4_294_967_295).optional(),
  contentType: z.string().max(256).optional(),
  responseTopic: MqttPublishTopicSchema.optional(),
  // MQTT 5 request/response correlation token, echoed back on the response topic.
  correlationData: z.string().max(4096).optional(),
});

export const MqttSubscribeSchema = z.object({
  connectionId: MqttConnectionIdSchema,
  topicFilter: MqttSubscribeFilterSchema,
  qos: MqttQoSSchema,
});

export const MqttUnsubscribeSchema = z.object({
  connectionId: MqttConnectionIdSchema,
  topicFilter: MqttSubscribeFilterSchema,
});

export const MqttDisconnectSchema = z.object({
  connectionId: MqttConnectionIdSchema,
});

export type MqttConnectConfig = z.infer<typeof MqttConnectSchema>;
export type MqttPublishConfig = z.infer<typeof MqttPublishSchema>;
export type MqttSubscribeConfig = z.infer<typeof MqttSubscribeSchema>;
export type MqttUnsubscribeConfig = z.infer<typeof MqttUnsubscribeSchema>;
export type MqttDisconnectConfig = z.infer<typeof MqttDisconnectSchema>;

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
  .regex(
    /^[a-zA-Z0-9._:-]+$/,
    'Key must contain only alphanumeric characters, dots, underscores, colons, or hyphens'
  );

export const StoreValueSchema = z.string().max(1024 * 1024, 'Value exceeds 1MB limit');

// store:set takes two args (key, value); createValidatedHandler validates 2+
// args as a tuple — same pattern as WriteFileSchema for fs:writeFile.
export const StoreSetSchema = z.tuple([StoreKeySchema, StoreValueSchema]);

// ===========================
// Log Schemas
// ===========================

export const LogHistoryLimitSchema = z.number().int().positive().max(1000).optional();

// ===========================
// Validation Helper
// ===========================

/**
 * Returns true iff `url` is one of the renderer entry points the main
 * process trusts:
 *   - file:// → the packaged Electron app's dist/web/index.html
 *   - http://localhost:5173 or http://127.0.0.1:5173 → the Vite dev server
 *     used during `npm run electron:dev` (see window-manager.ts)
 *
 * Any other origin (including arbitrary localhost ports, https://, or
 * https://attacker.example) is rejected. Hash router segments live in the
 * URL fragment and don't affect this check.
 */
function isTrustedFrameUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return true;
    if (
      u.protocol === 'http:' &&
      (u.hostname === 'localhost' || u.hostname === '127.0.0.1') &&
      u.port === '5173'
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Defense-in-depth guard: rejects IPC traffic whose senderFrame is not the
 * legitimate renderer entry point. Protects against a compromised child
 * frame, redirected webContents, or a popup window calling into the main
 * process.
 */
export function assertTrustedSender(
  channel: string,
  event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent
): void {
  const url = event.senderFrame?.url;
  if (!isTrustedFrameUrl(url)) {
    log.error('IPC frame rejected', { channel, senderFrame: url ?? '(undefined)' });
    throw new Error(`IPC ${channel} rejected: untrusted frame`);
  }
}

/**
 * Validates IPC input using a Zod schema
 * Throws a descriptive error if validation fails
 */
export function validateIpcInput<T>(schema: z.ZodSchema<T>, data: unknown, channel: string): T {
  try {
    return schema.parse(data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.issues
        .map((err) => `${err.path.join('.')}: ${err.message}`)
        .join(', ');

      log.error('IPC validation error', {
        channel,
        issues: error.issues,
        receivedData: data,
      });

      throw new Error(`Invalid IPC payload for ${channel}: ${errorMessages}`);
    }
    throw error;
  }
}

/**
 * Creates a validated IPC handler with automatic error handling.
 *
 * Argument unwrap:
 *   - 0 args (renderer invoked with no payload) → `undefined`
 *   - 1 arg                                     → `args[0]` (the typical case)
 *   - 2+ args                                   → the args array (validated as a tuple schema)
 *
 * The 0-args → undefined mapping is important: previously a zero-arg invoke
 * left `input = []` (empty array), which schemas like `z.object({})` reject
 * with "expected object, received array". `NoInputSchema` (`z.undefined()`)
 * is the right schema for those channels.
 */
export function createValidatedHandler<TInput, TOutput>(
  channel: string,
  schema: z.ZodSchema<TInput>,
  handler: (input: TInput) => Promise<TOutput> | TOutput
): (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<TOutput> {
  return async (event, ...args) => {
    assertTrustedSender(channel, event);
    const input = args.length === 0 ? undefined : args.length === 1 ? args[0] : args;
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
      assertTrustedSender(channel, event);
      const input = args.length === 0 ? undefined : args.length === 1 ? args[0] : args;
      const validated = validateIpcInput(schema, input, channel);
      handler(event, validated as TInput);
    } catch (error) {
      log.error('IPC listener error', {
        channel,
        error: error instanceof Error ? error.message : String(error),
      });
      // For .on() handlers, we can't return errors, so we just log
    }
  };
}

/**
 * Schema for IPC channels that accept no input. Used together with
 * `createValidatedHandler` so the wrapper still calls `assertTrustedSender`
 * but the input validation accepts the zero-args case cleanly. Don't use
 * `z.object({}).strict().optional()` here — the wrapper now maps zero-args
 * to `undefined`, which `z.undefined()` accepts and `z.object({})` does not.
 */
export const NoInputSchema = z.undefined();

// ===========================
// AI Chat Schemas
// ===========================

export const AiChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().max(200_000), // ~50k tokens; over this is almost certainly a bug
});

export const AiChatToolSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(4000),
  inputSchema: z.record(z.string(), z.unknown()),
});

export const AiChatRequestSchema = z.object({
  streamId: z.uuid(),
  provider: z.enum(['openai', 'anthropic', 'openrouter']),
  model: z.string().min(1).max(120),
  messages: z.array(AiChatMessageSchema).min(1).max(200),
  apiKeyHandleId: z.uuid(),
  baseUrlOverride: z.url().optional(),
  rawMode: z.boolean(),
  maxOutputTokens: z.number().int().positive().max(8192).optional(),
  tools: z.array(AiChatToolSchema).max(32).optional(),
});

export const AiChatCancelSchema = z.object({
  streamId: z.uuid(),
});

// ---------------------------------------------------------------------------
// AI Lab (Electron-only). Superset of the chat providers — adds local runtimes
// (Ollama, generic OpenAI-compatible). The API-key handle is OPTIONAL because a
// bare local Ollama needs no key. `openai-compatible` always needs a base URL
// (it has no sensible default); the handler/refine enforces that.
// ---------------------------------------------------------------------------
const AiLabProviderSchema = z.enum([
  'openai',
  'anthropic',
  'openrouter',
  'ollama',
  'openai-compatible',
]);

const AiLabCompleteBase = z.object({
  provider: AiLabProviderSchema,
  model: z.string().min(1).max(200),
  messages: z.array(AiChatMessageSchema).min(1).max(200),
  apiKeyHandleId: z.uuid().optional(),
  baseUrlOverride: z.url().optional(),
  rawMode: z.boolean(),
  maxOutputTokens: z.number().int().positive().max(32_768).optional(),
  tools: z.array(AiChatToolSchema).max(32).optional(),
});

const requireBaseForCompat = (v: { provider: string; baseUrlOverride?: string }) =>
  v.provider !== 'openai-compatible' || !!v.baseUrlOverride;

export const AiLabCompleteSchema = AiLabCompleteBase.refine(requireBaseForCompat, {
  message: 'openai-compatible provider requires a base URL.',
  path: ['baseUrlOverride'],
});

export const AiLabStreamSchema = AiLabCompleteBase.extend({
  streamId: z.uuid(),
}).refine(requireBaseForCompat, {
  message: 'openai-compatible provider requires a base URL.',
  path: ['baseUrlOverride'],
});

export const AiLabStreamCancelSchema = z.object({ streamId: z.uuid() });

export const AiLabDiscoverSchema = z.object({
  provider: AiLabProviderSchema,
  baseUrl: z.url(),
  apiKeyHandleId: z.uuid().optional(),
});
