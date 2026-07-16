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
}

export interface ElectronHttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
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
}

export interface GrpcReflectionConfig {
  url: string;
  reflectionService: string;
  request: Record<string, unknown>;
  timeout?: number;
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
  }) => Promise<{ success: boolean; error?: string }>;
  send: (config: {
    connectionId: string;
    message: string;
    binary?: boolean;
  }) => Promise<{ success: boolean; error?: string }>;
  disconnect: (config: { connectionId: string }) => Promise<{ success: boolean }>;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeAllListeners: (channel: string) => void;
}

export interface ElectronSseAPI {
  connect: (config: {
    connectionId: string;
    url: string;
    headers?: Record<string, string>;
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

export interface ElectronMcpAPI {
  connect: (config: {
    connectionId: string;
    url: string;
    transport: 'streamable-http' | 'http-sse';
    headers?: Record<string, string>;
  }) => Promise<{ success: boolean; error?: string }>;
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
  }>;
  disconnect: (config: { connectionId: string }) => Promise<{ success: boolean }>;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeAllListeners: (channel: string) => void;
}

export type KafkaSaslMechanism = 'PLAIN' | 'SCRAM-SHA-256' | 'SCRAM-SHA-512';

export interface KafkaTlsIpc {
  ca?: string;
  cert?: string;
  key?: string;
  passphrase?: string;
  rejectUnauthorized?: boolean;
}

export type KafkaAuthIpc =
  | { securityProtocol: 'PLAINTEXT' }
  | {
      securityProtocol: 'SASL_PLAINTEXT';
      sasl: { mechanism: KafkaSaslMechanism; username: string; password: string };
    }
  | {
      securityProtocol: 'SASL_SSL';
      sasl: { mechanism: KafkaSaslMechanism; username: string; password: string };
      tls?: KafkaTlsIpc;
    }
  | { securityProtocol: 'SSL'; tls: KafkaTlsIpc };

/**
 * Confluent Schema Registry config (resolved plaintext auth — secrets are
 * resolved main-side by kafkaManager before the IPC call). When present, the
 * consumer decodes Avro/Protobuf/JSON Schema messages via the registry.
 */
export interface KafkaRegistryIpc {
  url: string;
  auth?: { username?: string; password?: string; token?: string };
}

export interface KafkaAck {
  topic: string;
  partition: number;
  offset: string;
  timestamp: number;
}

/** Per-partition starting offset for MANUAL consume mode (offset is a numeric string). */
export interface KafkaPartitionOffset {
  topic: string;
  partition: number;
  offset: string;
}

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

export interface ElectronKafkaAPI {
  connect: (config: {
    connectionId: string;
    clientId: string;
    bootstrapBrokers: string[];
    auth: KafkaAuthIpc;
    /** Enable the idempotent producer (forces acks=-1 on the produce path). */
    idempotent?: boolean;
    /** Confluent Schema Registry — when set, the consumer decodes via it. */
    registry?: KafkaRegistryIpc;
  }) => Promise<{ success: boolean; error?: string }>;
  produce: (config: {
    connectionId: string;
    topic: string;
    key?: string;
    value: string;
    headers?: Record<string, string>;
    partition?: number;
    acks: 0 | 1 | -1;
    compression?: 'none' | 'gzip' | 'snappy' | 'lz4' | 'zstd';
    /** Confluent value schema id — encodes the (JSON) value via the registry. */
    valueSchemaId?: number;
    /** Confluent key schema id — encodes the (JSON) key via the registry. */
    keySchemaId?: number;
  }) => Promise<{ success: boolean; ack?: KafkaAck; error?: string }>;
  subscribe: (config: {
    connectionId: string;
    groupId: string;
    topics: string[];
    fromBeginning: boolean;
    /**
     * Start position. 'manual' seeks to the explicit `offsets` below;
     * 'timestamp' resolves each partition's first offset at/after `timestamp`.
     */
    mode?: 'latest' | 'earliest' | 'manual' | 'timestamp';
    offsets?: KafkaPartitionOffset[];
    /** Epoch-millis as a numeric string. Required when mode === 'timestamp'. */
    timestamp?: string;
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
  /** Reset a group's committed offsets for one topic (group must be inactive). */
  resetGroupOffsets: (config: {
    connectionId: string;
    groupId: string;
    topic: string;
    to: 'earliest' | 'latest' | 'specific';
    partitions?: { partition: number; offset: string }[];
  }) => Promise<{ success: boolean; error?: string }>;
  /** Delete a consumer group (group must be empty/inactive). */
  deleteGroup: (config: {
    connectionId: string;
    groupId: string;
  }) => Promise<{ success: boolean; error?: string }>;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeAllListeners: (channel: string) => void;
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
  connectTimeout: number;
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
