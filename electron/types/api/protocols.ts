export type ProtocolSecretValue = import('../../../shared/protocol/types').ProtocolSecretValue;

export interface ElectronHttpProxyConfig {
  enabled: boolean;
  type: 'http' | 'https' | 'socks4' | 'socks5' | 'pac';
  host: string;
  port: number;
  pacUrl?: string;
  auth?: {
    username: string;
    // SecretValue (ADR-0007) — resolved to plaintext in the main process.
    password: ProtocolSecretValue;
  };
}

export interface ElectronHttpClientCert {
  format: 'pfx' | 'pem';
  pfx?: string;
  cert?: string;
  key?: string;
  passphrase?: ProtocolSecretValue;
}

export interface ElectronHttpCaCert {
  pem: string;
}

export interface ElectronHttpFormField {
  name: string;
  value: string;
  // `| undefined` (not bare `?`) so the Zod-inferred ProxyRequestBody.formData
  // assigns cleanly under exactOptionalPropertyTypes.
  filename?: string | undefined;
  contentType?: string | undefined;
}

export interface ElectronHttpRequestConfig {
  requestId: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  data?: string;
  // Structured body (drives the shared body-builder): binary base64 rides in
  // `data` with bodyType:'binary'; multipart fields ride in `formData`.
  bodyType?: 'none' | 'json' | 'text' | 'raw' | 'form-urlencoded' | 'form-data' | 'binary';
  formData?: ElectronHttpFormField[];
  timeout?: number;
  maxRedirects?: number;
  proxy?: ElectronHttpProxyConfig;
  verifySsl?: boolean;
  clientCert?: ElectronHttpClientCert;
  caCert?: ElectronHttpCaCert;
  // Redirect / URL handling (cross-platform)
  followOriginalMethod?: boolean;
  followAuthHeader?: boolean;
  stripReferer?: boolean;
  encodeUrlAutomatically?: boolean;
  // TLS (desktop-only enforcement; mirrors HttpRequestConfigSchema)
  serverCipherOrder?: boolean;
  minTlsVersion?: 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';
  cipherSuites?: string;
  // HTTP version preference (#864; desktop-only)
  httpVersion?: import('../../../shared/types/http').HttpVersionPreference;
}

export interface ElectronHttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Every Set-Cookie field, one entry each (RFC 6265 §3 — never folded). */
  setCookies?: string[];
  data: unknown;
  /** Decoded byte size of the response body. */
  size?: number;
  /** 'base64' when `data` is base64 of a binary body (see shared/protocol/binary.ts). */
  bodyEncoding?: 'base64';
  /**
   * Negotiated ALPN protocol from undici (h2 / h1.1 / h3 when available).
   * Surfaced by the renderer as a small "HTTP/2" / "HTTP/1.1" badge.
   */
  negotiatedAlpn?: 'h1.1' | 'h2' | 'h3';
  /** Why the body was left undecoded (e.g. unsupported Content-Encoding), when it was. */
  bodyNotice?: string;
  /** Timing breakdown of the final hop (shared/protocol ResponseTimings). */
  timings?: import('../../../shared/protocol/types').ResponseTimings;
}

export interface ElectronHttpAPI {
  request: (config: ElectronHttpRequestConfig) => Promise<ElectronHttpResponse>;
  cancel: (args: {
    requestId: string;
  }) => Promise<{ ok: true; alreadyDone?: true } | { ok: false; error: string }>;
}

export interface GrpcIpcResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  message?: unknown;
  messages?: unknown[];
  trailers: Record<string, string>;
  error?: string;
  details?: string;
  /** Decoded google.rpc.Status error details (see shared/protocol/grpc-status-details). */
  statusDetails?: import('../../../shared/protocol/grpc-status-details').GrpcStatusDetail[];
}

export interface GrpcReflectionConfig {
  url: string;
  reflectionService: string;
  request: Record<string, unknown>;
  timeout?: number;
  /** Request metadata (incl. inline auth headers) sent with reflection (#887). */
  metadata?: Record<string, string>;
  /**
   * Auth descriptor, only when it holds a SecretRef handle the renderer can't
   * read; resolved main-side (ADR-0007). Validated by ReflectionIpcConfigSchema.
   */
  auth?: unknown;
  // TLS trust / mTLS material (resolved per-host from cert-override settings),
  // so Discover reaches a self-signed / private-CA / mTLS server.
  verifySsl?: boolean;
  clientCert?: { pfx?: string; cert?: string; key?: string; passphrase?: unknown };
  caCert?: { pem: string };
}

export interface GrpcRawReflectionResponse {
  listServicesResponse?: { service: Array<{ name: string }> };
  fileDescriptorResponse?: { fileDescriptorProto: string[] };
  errorResponse?: { errorCode: number; errorMessage: string };
}

export interface ElectronGrpcAPI {
  request: (config: unknown) => Promise<GrpcIpcResult>;
  reflect: (config: GrpcReflectionConfig) => Promise<GrpcRawReflectionResponse>;
  startStream: (config: unknown) => void;
  sendMessage: (requestId: string, message: unknown) => void;
  endStream: (requestId: string) => void;
  cancelStream: (requestId: string) => void;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
}

export interface ElectronWebSocketAPI {
  connect: (config: {
    connectionId: string;
    url: string;
    headers?: Record<string, string>;
    protocols?: string[];
    /**
     * Header-shaped auth descriptor whose SecretRef handle(s) the renderer
     * can't read; resolved main-side into the handshake (ADR-0007).
     * Validated by `WsConnectSchema` (AuthConfigSchema).
     */
    auth?: import('../../../shared/types/auth').AuthConfig;
    /** SecretRef-backed `{{vars}}` referenced from url/headers/auth. */
    secretVariables?: Record<string, ProtocolSecretValue>;
    /** false disables the permessage-deflate offer (default true). */
    perMessageDeflate?: boolean;
  }) => Promise<{ success: boolean; error?: string }>;
  send: (config: {
    connectionId: string;
    message: string;
    binary?: boolean;
  }) => Promise<{ success: boolean; error?: string }>;
  /** Send a Ping control frame; `payload` is UTF-8 text, at most 125 bytes. */
  ping: (config: {
    connectionId: string;
    payload?: string;
  }) => Promise<{ success: boolean; error?: string }>;
  /** `code` must be 1000 or 3000-4999; `reason` at most 123 UTF-8 bytes. */
  disconnect: (config: {
    connectionId: string;
    code?: number;
    reason?: string;
  }) => Promise<{ success: boolean }>;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeAllListeners: (channel: string) => void;
}

export interface ElectronSseAPI {
  connect: (config: {
    connectionId: string;
    url: string;
    headers?: Record<string, string>;
    /** graphql-sse: header-shaped auth with SecretRef handles, resolved main-side (ADR-0007). */
    auth?: import('../../../shared/types/auth').AuthConfig;
    /** graphql-sse: SecretRef-backed `{{vars}}` referenced from url/headers/auth. */
    secretVariables?: Record<string, ProtocolSecretValue>;
    /** POST this JSON body instead of a plain GET (GraphQL over SSE). */
    jsonBody?: string;
  }) => Promise<{ success: boolean; error?: string }>;
  disconnect: (config: { connectionId: string }) => Promise<{ success: boolean }>;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeAllListeners: (channel: string) => void;
}

export interface SocketIoConnectIpcConfig {
  connectionId: string;
  url: string;
  namespace?: string;
  path?: string;
  auth?: Record<string, string | number | boolean>;
  query?: Record<string, string>;
  extraHeaders?: Record<string, string>;
  transports?: Array<'websocket' | 'polling'>;
  reconnection?: boolean;
  reconnectionAttempts?: number;
  reconnectionDelay?: number;
  timeout?: number;
  forceNew?: boolean;
}

export interface SocketIoEmitIpcConfig {
  connectionId: string;
  eventName: string;
  args: unknown[];
  ackId?: string;
  ackTimeoutMs?: number;
}

export interface ElectronSocketIoAPI {
  connect: (config: SocketIoConnectIpcConfig) => Promise<{ success: boolean; error?: string }>;
  emit: (config: SocketIoEmitIpcConfig) => Promise<{ success: boolean; error?: string }>;
  disconnect: (config: { connectionId: string }) => Promise<{ success: boolean }>;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeAllListeners: (channel: string) => void;
}

/** SecretRef-shaped env value for a stdio MCP server; handles resolve in main. */
export type McpStdioEnvValueIpc =
  | string
  | { kind: 'inline'; value: string }
  | { kind: 'handle'; id: string; label?: string };

export type McpConnectIpcConfig =
  | {
      connectionId: string;
      url: string;
      transport: 'streamable-http' | 'http-sse';
      headers?: Record<string, string>;
      /**
       * Header-shaped connection auth (#896). SecretRef handles are resolved in
       * Electron main at connect time — the renderer never sees the plaintext.
       */
      auth?: import('../../../shared/types/auth').AuthConfig;
    }
  | {
      connectionId: string;
      transport: 'stdio';
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, McpStdioEnvValueIpc>;
    };

export interface McpOAuthStatusIpc {
  signedIn: boolean;
  canRefresh: boolean;
  expiresAt?: number;
  scope?: string;
  dynamicallyRegistered: boolean;
}

export interface McpImportScanResult {
  /** Null when the user cancelled the picker or nothing was found. */
  sessionId: string | null;
  sources: import('../../../shared/mcp-import/mcp-import-model').McpImportPreviewSource[];
}

export interface McpImportCommitResult {
  drafts: import('../../../shared/mcp-import/mcp-import-model').McpImportDraft[];
  skipped: Array<{ key: string; name: string; reason: string }>;
}

export interface ElectronMcpAPI {
  connect: (config: McpConnectIpcConfig) => Promise<{
    success: boolean;
    error?: string;
    /** #856: the OAuth sign-in lapsed and can't refresh — prompt to sign in again. */
    authRequired?: boolean;
  }>;
  request: (config: {
    connectionId: string;
    method: string;
    params?: unknown;
    requestId?: string | number;
    timeout?: number;
  }) => Promise<{
    success: boolean;
    result?: unknown;
    error?: string;
    jsonRpcError?: { code: number; message: string; data?: unknown };
    /** #856: the OAuth sign-in lapsed and can't refresh — prompt to sign in again. */
    authRequired?: boolean;
    /** True when the request was aborted via `cancel` (distinct from an error). */
    cancelled?: boolean;
  }>;
  /** Abort one in-flight request; the SDK sends `notifications/cancelled`. */
  cancel: (config: {
    connectionId: string;
    requestId: string | number;
  }) => Promise<{ success: boolean }>;
  disconnect: (config: { connectionId: string }) => Promise<{ success: boolean }>;
  /** Forget every "Always allow" stdio launch approval. */
  revokeStdioApprovals: () => Promise<{ success: boolean; revoked: number }>;
  /** Answer a server→client request delivered on `mcp:client-request:<connectionId>` (#860). */
  respondClientRequest: (
    response: McpClientResponseIpc
  ) => Promise<
    { success: true } | { success: false; error: string; fieldErrors?: Record<string, string> }
  >;
  /** Replace the connection's roots; live sessions get notifications/roots/list_changed. */
  setRoots: (config: {
    connectionId: string;
    roots: McpRootIpc[];
  }) => Promise<{ success: true; notified: number } | { success: false; error: string }>;
  /**
   * MCP OAuth 2.1 (#856): plaintext-free sign-in status for a server (+ static
   * client id). Tokens never cross IPC.
   */
  oauthStatus: (target: { url: string; clientId?: string }) => Promise<McpOAuthStatusIpc>;
  /** Forget the stored MCP OAuth tokens / registration for a server. */
  oauthSignOut: (target: { url: string; clientId?: string }) => Promise<{ success: boolean }>;
  /** Scan well-known MCP client configs, or a file the user picks in a main-owned dialog. */
  importScan: (input: { source: 'detect' | 'pick' }) => Promise<McpImportScanResult>;
  /** Create drafts for the selected scan entries; secret env values are stored as handles in main. */
  importCommit: (input: { sessionId: string; keys: string[] }) => Promise<McpImportCommitResult>;
  /** Era/conformance run (#911); the report is JSON-safe (`McpConformanceReport`). */
  conformance: (config: {
    url: string;
    transport: 'streamable-http' | 'http-sse';
    headers?: Record<string, string>;
    sampleCalls?: 'off' | 'read-only' | 'selected';
    approvedTools?: string[];
    eras?: Array<'legacy' | 'modern'>;
  }) => Promise<
    | {
        success: true;
        report: import('../../../shared/protocol/mcp-conformance').McpConformanceReport;
      }
    | { success: false; error: string }
  >;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeAllListeners: (channel: string) => void;
}

export interface McpRootIpc {
  uri: string;
  name?: string;
}

export type McpClientResponseIpc =
  | {
      kind: 'elicitation';
      connectionId: string;
      requestId: string;
      response:
        | { action: 'accept'; content: Record<string, string | number | boolean | string[]> }
        | { action: 'decline' }
        | { action: 'cancel' };
    }
  | {
      kind: 'sampling';
      connectionId: string;
      requestId: string;
      response: { action: 'approve'; text: string; model: string } | { action: 'reject' };
    };

export type KafkaSaslMechanism =
  | 'PLAIN'
  | 'SCRAM-SHA-256'
  | 'SCRAM-SHA-512'
  | 'OAUTHBEARER'
  | 'GSSAPI'
  | 'AWS_MSK_IAM';

export interface KafkaTlsIpc {
  ca?: string;
  cert?: string;
  key?: string;
  passphrase?: string;
  rejectUnauthorized?: boolean;
}

export type KafkaSaslIpc =
  | {
      mechanism: 'PLAIN' | 'SCRAM-SHA-256' | 'SCRAM-SHA-512';
      username: string;
      password: string;
    }
  | {
      mechanism: 'OAUTHBEARER';
      mode?: 'static';
      token: string;
      extensions?: Record<string, string>;
    }
  | {
      // OAuth 2.0 client-credentials — main fetches + refreshes the token.
      mechanism: 'OAUTHBEARER';
      mode: 'client-credentials';
      tokenEndpoint: string;
      clientId: string;
      /** SecretValue (ADR-0007) — resolved to plaintext in the main process. */
      clientSecret: ProtocolSecretValue;
      scope?: string;
      extensions?: Record<string, string>;
    }
  | { mechanism: 'GSSAPI'; serviceName?: string; principal?: string }
  | {
      mechanism: 'AWS_MSK_IAM';
      region: string;
      /** Opt-in: allow brokers outside *.kafka.<region>.amazonaws.com (PrivateLink / custom DNS). */
      allowNonAwsBrokerHosts?: boolean;
      credentials:
        | {
            source: 'static';
            accessKeyId: string;
            /** SecretValue (ADR-0007) — resolved to plaintext in the main process. */
            secretAccessKey: ProtocolSecretValue;
            sessionToken?: ProtocolSecretValue;
          }
        | { source: 'profile'; profile: string };
    };

export type KafkaAuthIpc =
  | { securityProtocol: 'PLAINTEXT' }
  | {
      securityProtocol: 'SASL_PLAINTEXT';
      sasl: KafkaSaslIpc;
    }
  | {
      securityProtocol: 'SASL_SSL';
      sasl: KafkaSaslIpc;
      tls?: KafkaTlsIpc;
    }
  | { securityProtocol: 'SSL'; tls: KafkaTlsIpc };

/**
 * Confluent Schema Registry config. Basic auth arrives as resolved plaintext
 * (kafkaManager resolves secureStorage sentinels); a bearer token is a
 * SecretValue — keychain handles / external refs are resolved only in main.
 * Registry HTTPS uses the execution policy's TLS selection (CA, mTLS, verify).
 */
export type KafkaRegistryAuthIpc =
  | { type?: 'basic'; username?: string; password?: string }
  | { type: 'bearer'; token: ProtocolSecretValue };

export interface KafkaRegistryIpc {
  url: string;
  auth?: KafkaRegistryAuthIpc;
}

export type KafkaRegistryVersionIpc = number | 'latest';
export type KafkaRegistrySchemaType = 'AVRO' | 'JSON' | 'PROTOBUF';

export interface KafkaRegistrySchemaIpc {
  id: number;
  subject: string;
  version: number;
  schemaType: KafkaRegistrySchemaType;
  schema: string;
  references: { name: string; subject: string; version: number }[];
}

/** Registry schema that decoded a consumed field (subject/version when resolvable). */
export interface KafkaSchemaRefIpc {
  id: number;
  subject?: string;
  version?: number;
}

export interface KafkaAck {
  topic: string;
  partition: number;
  offset: string;
  timestamp: number;
}

export type KafkaDataFieldIpc =
  | { encoding: 'utf8'; data: string }
  | { encoding: 'base64'; data: string };

export type KafkaRecordFieldIpc =
  | KafkaDataFieldIpc
  | { encoding: 'schema'; schemaId: number; data: string }
  | { encoding: 'schema'; subject: string; version: KafkaRegistryVersionIpc; data: string }
  | { encoding: 'null' };

export interface KafkaRecordIpc {
  topic: string;
  key?: KafkaRecordFieldIpc;
  value: KafkaRecordFieldIpc;
  headers?: { key: KafkaDataFieldIpc; value: KafkaDataFieldIpc }[];
  partition?: number;
  /** Epoch milliseconds as a numeric string to preserve bigint precision over IPC. */
  timestamp?: string;
}

export interface KafkaSendOptionsIpc {
  connectionId: string;
  acks: 0 | 1 | -1;
  compression?: 'none' | 'gzip' | 'snappy' | 'lz4' | 'zstd';
}

/** Per-partition starting offset for MANUAL consume mode (offset is a numeric string). */
export interface KafkaPartitionOffset {
  topic: string;
  partition: number;
  offset: string;
}

/** A topic partition addressed by a live-consumer control (pause/resume/seek). */
export interface KafkaTopicPartition {
  topic: string;
  partition: number;
}

/** Result of a partition pause/resume: the partitions still paused afterwards. */
export interface KafkaPartitionControlResult {
  success: boolean;
  error?: string;
  pausedPartitions?: KafkaTopicPartition[];
}

/** Where a live seek lands: an exact offset, or the first record at/after a timestamp (epoch ms). */
export type KafkaSeekTarget =
  | { kind: 'offset'; offset: string }
  | { kind: 'timestamp'; timestamp: string };

/** A consumer group as returned by Admin.listGroups (Map flattened to an array). */
export interface KafkaGroupInfo {
  id: string;
  state: string;
  groupType: string;
  protocolType: string;
}

/** Per-partition watermarks for a topic (offsets are numeric strings). */
export interface KafkaPartitionWatermark {
  partition: number;
  low: string;
  high: string;
  count: string;
}

/** A single topic config entry (Admin.describeConfigs, flattened). */
export interface KafkaTopicConfigEntry {
  name: string;
  value: string | null;
  source: string;
  isDefault: boolean;
  isSensitive: boolean;
  readOnly: boolean;
}

/** A consumer-group member with its partition assignments. */
export interface KafkaGroupMemberInfo {
  memberId: string;
  clientId: string;
  clientHost: string;
  assignments: { topic: string; partitions: number[] }[];
}

/** A consumer group's describe output (Admin.describeGroups, flattened). */
export interface KafkaGroupDescription {
  id: string;
  state: string;
  protocol: string;
  protocolType: string;
  members: KafkaGroupMemberInfo[];
}

/** Per-partition committed offset + log-end + computed lag for a group. */
export interface KafkaPartitionLag {
  topic: string;
  partition: number;
  /** Committed offset, or null when the group has not committed this partition. */
  committed: string | null;
  logEnd: string;
  lag: string;
}

export type KafkaOffsetResetTarget = 'earliest' | 'latest' | 'specific' | 'timestamp' | 'shift';

/** One partition of an offset-reset plan/result. */
export interface KafkaOffsetResetRow {
  topic: string;
  partition: number;
  /** Committed offset before the reset, or null when none was committed. */
  previous: string | null;
  offset: string;
  /** Why the target differs from the literal request (timestamp fallback / shift clamp). */
  note?: 'timestamp-fallback-latest' | 'clamped-earliest' | 'clamped-latest';
}

/**
 * A partition left untouched: a shift reset with no committed offset to move, or
 * (all-topics scope) a committed topic that has since been deleted.
 */
export interface KafkaOffsetResetSkip {
  topic: string;
  partition: number;
  reason: 'no-committed-offset' | 'unknown-topic';
}

export interface ElectronKafkaAPI {
  connect: (config: {
    connectionId: string;
    clientId: string;
    bootstrapBrokers: string[];
    auth: KafkaAuthIpc;
    /** Enable the idempotent producer (forces acks=-1 on the produce path). */
    idempotent?: boolean;
    /** Stable identifier required for producer transaction sessions. */
    transactionalId?: string;
    /** Confluent Schema Registry — when set, the consumer decodes via it. */
    registry?: KafkaRegistryIpc;
  }) => Promise<{ success: boolean; error?: string }>;
  produce: (
    config: KafkaSendOptionsIpc & { record: KafkaRecordIpc }
  ) => Promise<{ success: boolean; ack?: KafkaAck; error?: string }>;
  produceBatch: (
    config: KafkaSendOptionsIpc & { records: KafkaRecordIpc[] }
  ) => Promise<{ success: boolean; acks?: KafkaAck[]; error?: string }>;
  openProducerStream: (
    config: KafkaSendOptionsIpc & {
      highWaterMark?: number;
      batchSize?: number;
      batchTime?: number;
    }
  ) => Promise<{ success: boolean; error?: string }>;
  writeProducerStream: (config: {
    connectionId: string;
    record: KafkaRecordIpc;
  }) => Promise<{ success: boolean; accepted?: boolean; error?: string }>;
  closeProducerStream: (config: {
    connectionId: string;
  }) => Promise<{ success: boolean; error?: string }>;
  beginTransaction: (config: {
    connectionId: string;
  }) => Promise<{ success: boolean; transactionId?: string; error?: string }>;
  endTransaction: (config: {
    connectionId: string;
    action: 'commit' | 'abort';
  }) => Promise<{ success: boolean; error?: string }>;
  subscribe: (config: {
    connectionId: string;
    /** `browse` = no consumer group, no commits (#930). Omitted means `group`. */
    membership?: 'browse' | 'group';
    /** Required in group mode; must be omitted in browse mode. */
    groupId?: string;
    topics: string[];
    mode: 'committed' | 'latest' | 'earliest' | 'manual' | 'timestamp' | 'last-n';
    /** Browse `last-n` start: records per partition. */
    lastN?: number;
    /** Browse only: stop after this many records in total. */
    maxMessages?: number;
    fallbackMode?: 'latest' | 'earliest' | 'fail';
    offsets?: KafkaPartitionOffset[];
    timestamp?: string;
    commitPolicy?: 'auto' | 'manual';
    autoCommitIntervalMs?: number;
    isolation?: 'read-uncommitted' | 'read-committed';
    groupProtocol?: 'classic' | 'consumer';
    groupInstanceId?: string;
    groupRemoteAssignor?: string;
    sessionTimeoutMs?: number;
    rebalanceTimeoutMs?: number;
    heartbeatIntervalMs?: number;
    minBytes?: number;
    maxBytes?: number;
    maxBytesPerPartition?: number;
    maxWaitTimeMs?: number;
    highWaterMark?: number;
    lagIntervalMs?: number;
  }) => Promise<{ success: boolean; error?: string }>;
  pauseConsumer: (config: {
    connectionId: string;
  }) => Promise<{ success: boolean; error?: string }>;
  resumeConsumer: (config: {
    connectionId: string;
  }) => Promise<{ success: boolean; error?: string }>;
  /** Withhold records from these partitions; the rest of the subscription keeps flowing. */
  pausePartitions: (config: {
    connectionId: string;
    partitions: KafkaTopicPartition[];
  }) => Promise<KafkaPartitionControlResult>;
  /** Resume paused partitions from the first record withheld while they were paused. */
  resumePartitions: (config: {
    connectionId: string;
    partitions: KafkaTopicPartition[];
  }) => Promise<KafkaPartitionControlResult>;
  /** Reposition one partition of the live consumer; resolves with the offset it landed on. */
  seekConsumer: (config: {
    connectionId: string;
    topic: string;
    partition: number;
    target: KafkaSeekTarget;
  }) => Promise<{ success: boolean; error?: string; offset?: string }>;
  commitMessage: (config: {
    connectionId: string;
    commitToken: string;
  }) => Promise<{ success: boolean; error?: string }>;
  unsubscribe: (config: { connectionId: string }) => Promise<{ success: boolean; error?: string }>;
  disconnect: (config: { connectionId: string }) => Promise<{ success: boolean }>;
  // Admin (topic + consumer-group management). Each constructs a short-lived
  // Admin client from the live connection's auth/TLS.
  listTopics: (config: {
    connectionId: string;
  }) => Promise<{ success: boolean; topics?: string[]; error?: string }>;
  createTopic: (config: {
    connectionId: string;
    topic: string;
    partitions: number;
    replicationFactor: number;
  }) => Promise<{ success: boolean; error?: string }>;
  deleteTopic: (config: {
    connectionId: string;
    topic: string;
  }) => Promise<{ success: boolean; error?: string }>;
  listGroups: (config: {
    connectionId: string;
  }) => Promise<{ success: boolean; groups?: KafkaGroupInfo[]; error?: string }>;
  /** Topic inspector: per-partition watermarks + topic config. */
  inspectTopic: (config: { connectionId: string; topic: string }) => Promise<{
    success: boolean;
    partitions?: KafkaPartitionWatermark[];
    config?: KafkaTopicConfigEntry[];
    error?: string;
  }>;
  /** Consumer-group inspector: members/state + committed offsets + computed lag. */
  inspectGroup: (config: { connectionId: string; groupId: string }) => Promise<{
    success: boolean;
    group?: KafkaGroupDescription | null;
    offsets?: KafkaPartitionLag[];
    error?: string;
  }>;
  /**
   * Reset a group's committed offsets for one topic or all committed topics
   * (group must be inactive). `dryRun` returns the plan without committing it.
   */
  resetGroupOffsets: (config: {
    connectionId: string;
    groupId: string;
    topic?: string;
    allTopics?: boolean;
    to: KafkaOffsetResetTarget;
    partitions?: { partition: number; offset: string }[];
    /** Epoch milliseconds, for `to: 'timestamp'`. */
    timestamp?: number;
    /** Relative move (±N), for `to: 'shift'`. */
    shift?: number;
    dryRun?: boolean;
  }) => Promise<{
    success: boolean;
    offsets?: KafkaOffsetResetRow[];
    skipped?: KafkaOffsetResetSkip[];
    dryRun?: boolean;
    error?: string;
  }>;
  /** Delete a group's committed offsets (KIP-496 OffsetDelete; group must be inactive). */
  deleteGroupOffsets: (config: {
    connectionId: string;
    groupId: string;
    topic?: string;
    allTopics?: boolean;
    partitions?: number[];
  }) => Promise<{
    success: boolean;
    deleted?: { topic: string; partitions: number[] }[];
    skipped?: KafkaOffsetResetSkip[];
    error?: string;
  }>;
  /** Delete a consumer group (group must be empty/inactive). */
  deleteGroup: (config: {
    connectionId: string;
    groupId: string;
  }) => Promise<{ success: boolean; error?: string }>;
  createPartitions: (config: {
    connectionId: string;
    topic: string;
    count: number;
    validateOnly: boolean;
    confirmation?: string;
  }) => Promise<{ success: boolean; error?: string }>;
  alterTopicConfigs: (config: {
    connectionId: string;
    topic: string;
    configs: {
      name: string;
      operation: 'set' | 'delete' | 'append' | 'subtract';
      value?: string;
    }[];
    validateOnly: boolean;
    confirmation?: string;
  }) => Promise<{ success: boolean; error?: string }>;
  deleteRecords: (config: {
    connectionId: string;
    topic: string;
    partitions: { partition: number; offset: string }[];
    confirmation: string;
  }) => Promise<{
    success: boolean;
    lowWatermarks?: { partition: number; offset: string }[];
    error?: string;
  }>;
  describeCluster: (config: { connectionId: string }) => Promise<{
    success: boolean;
    cluster?: {
      id: string;
      controllerId: number;
      brokers: { id: number; host: string; port: number; rack: string | null }[];
      topics: { name: string; partitions: number }[];
    };
    error?: string;
  }>;
  describeAcls: (config: { connectionId: string; filter: KafkaAclIpc }) => Promise<{
    success: boolean;
    acls?: unknown[];
    error?: string;
  }>;
  createAcl: (config: {
    connectionId: string;
    acl: KafkaAclIpc;
    confirmation: string;
  }) => Promise<{ success: boolean; error?: string }>;
  deleteAcls: (config: {
    connectionId: string;
    filter: KafkaAclIpc;
    confirmation: string;
  }) => Promise<{ success: boolean; deleted?: unknown[]; error?: string }>;
  describeQuotas: (config: {
    connectionId: string;
    entities: KafkaQuotaEntityIpc[];
  }) => Promise<{ success: boolean; quotas?: unknown[]; error?: string }>;
  alterQuotas: (config: {
    connectionId: string;
    entities: KafkaQuotaEntityIpc[];
    operations: {
      key: 'producer_byte_rate' | 'consumer_byte_rate' | 'request_percentage';
      value?: number;
      remove: boolean;
    }[];
    validateOnly: boolean;
    confirmation?: string;
  }) => Promise<{ success: boolean; results?: unknown[]; error?: string }>;
  // Schema Registry browsing (subject picker / schema viewer).
  registryListSubjects: (config: {
    connectionId: string;
  }) => Promise<{ success: boolean; subjects?: string[]; error?: string }>;
  registryListVersions: (config: {
    connectionId: string;
    subject: string;
  }) => Promise<{ success: boolean; versions?: number[]; error?: string }>;
  registryGetSchema: (config: {
    connectionId: string;
    subject: string;
    version: KafkaRegistryVersionIpc;
  }) => Promise<{ success: boolean; schema?: KafkaRegistrySchemaIpc; error?: string }>;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeAllListeners: (channel: string) => void;
}

export interface KafkaAclIpc {
  resourceType: number;
  resourceName?: string | null;
  resourcePatternType: number;
  principal?: string | null;
  host?: string | null;
  operation: number;
  permissionType: number;
}

export interface KafkaQuotaEntityIpc {
  entityType: 'user' | 'client-id';
  entityName?: string | null;
}

// MQTT — desktop-only pub/sub over mqtt:// (TCP) / mqtts:// (TLS).
export type MqttProtocolVersion = 4 | 5; // 4 = MQTT 3.1.1, 5 = MQTT 5.0
export type MqttQoS = 0 | 1 | 2;

export interface MqttTlsIpc {
  ca?: string;
  cert?: string;
  key?: string;
  passphrase?: string;
  rejectUnauthorized?: boolean;
}

export interface MqttLwtIpc {
  topic: string;
  payload: string;
  qos: MqttQoS;
  retain: boolean;
}

export interface MqttConnectIpc {
  connectionId: string;
  brokerUrl: string;
  protocolVersion: MqttProtocolVersion;
  clientId: string;
  keepalive: number;
  cleanStart: boolean;
  connectTimeout?: number;
  autoReconnect: boolean;
  username?: string;
  password?: string;
  tls?: MqttTlsIpc;
  lwt?: MqttLwtIpc;
  sessionExpiryInterval?: number;
}

export interface MqttPublishIpc {
  connectionId: string;
  topic: string;
  payload: string;
  qos: MqttQoS;
  retain: boolean;
  userProperties?: Record<string, string | string[]>;
  messageExpiryInterval?: number;
  contentType?: string;
  responseTopic?: string;
  correlationData?: string;
}

export interface MqttPublishAck {
  topic: string;
  qos: MqttQoS;
  packetId?: number;
  reasonCode?: number;
  timestamp: number;
}

export interface ElectronMqttAPI {
  connect: (config: MqttConnectIpc) => Promise<{ success: boolean; error?: string }>;
  publish: (
    config: MqttPublishIpc
  ) => Promise<{ success: boolean; ack?: MqttPublishAck; error?: string }>;
  subscribe: (config: {
    connectionId: string;
    topicFilter: string;
    qos: MqttQoS;
  }) => Promise<{ success: boolean; error?: string }>;
  unsubscribe: (config: {
    connectionId: string;
    topicFilter: string;
  }) => Promise<{ success: boolean; error?: string }>;
  disconnect: (config: { connectionId: string }) => Promise<{ success: boolean }>;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeAllListeners: (channel: string) => void;
}
