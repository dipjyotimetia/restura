// Type definitions for the Electron API exposed via the preload script.
//
// SINGLE SOURCE OF TRUTH for the IPC surface. This module is imported by both
// programs:
//   - the renderer (`tsconfig.json` includes `electron/types/**/*.ts`), which
//     reads `window.electron` typed via the `declare global` block below; and
//   - the Electron main program (`electron/tsconfig.json`), where `preload.ts`
//     does `const electronAPI = { ... } satisfies ElectronAPI`.
// Because preload `satisfies` this interface, any drift between the declared
// surface and the real preload object is a COMPILE ERROR under
// `npm run electron:compile` (which runs in CI). Keep this file the canonical
// definition — do not reintroduce a parallel `typeof electronAPI` type.

// SecretValue (ADR-0007) for the proxy password / cert passphrase IPC fields.
// Inline import matches this file's convention (see ChatStreamEvent below);
// the renderer tsconfig that includes this file resolves the relative path.
type ProtocolSecretValue = import('../../shared/protocol/types').ProtocolSecretValue;

interface ElectronDialogAPI {
  openFile: (options?: {
    title?: string;
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
    properties?: Array<'openFile' | 'openDirectory' | 'multiSelections'>;
  }) => Promise<{
    canceled: boolean;
    filePaths: string[];
  }>;

  saveFile: (options?: {
    title?: string;
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }) => Promise<{
    canceled: boolean;
    filePath?: string;
  }>;
}

interface ElectronFSAPI {
  readFile: (filePath: string) => Promise<{
    success: boolean;
    content?: string;
    error?: string;
  }>;

  writeFile: (
    filePath: string,
    content: string
  ) => Promise<{
    success: boolean;
    error?: string;
  }>;
}

interface ElectronAppAPI {
  // Keep in sync with AppPathNameSchema in electron/main/ipc/ipc-validators.ts.
  getPath: (
    name:
      | 'home'
      | 'appData'
      | 'userData'
      | 'sessionData'
      | 'cache'
      | 'temp'
      | 'exe'
      | 'module'
      | 'desktop'
      | 'documents'
      | 'downloads'
      | 'music'
      | 'pictures'
      | 'videos'
      | 'recent'
      | 'logs'
      | 'crashDumps'
  ) => Promise<string>;
  getVersion: () => Promise<string>;
  checkForUpdates: () => Promise<{
    updateAvailable: boolean;
    version?: string;
    message?: string;
    error?: string;
  }>;
}

interface ElectronShellAPI {
  openExternal: (url: string) => Promise<void>;
}

/**
 * Auto-updater state pushed main→renderer over EVENT.updaterStatus. Single
 * discriminated shape keyed on `state` — maps to one renderer state machine.
 */
interface UpdaterStatus {
  state:
    'idle' | 'checking' | 'not-available' | 'available' | 'downloading' | 'downloaded' | 'error';
  /** Present for `available` / `downloaded`. */
  version?: string;
  /** Download completion 0–100, present for `downloading`. */
  percent?: number;
  /** Human-readable detail for `error` / `not-available`. */
  message?: string;
}

interface ElectronUpdaterAPI {
  check: () => Promise<{
    updateAvailable: boolean;
    version?: string;
    message?: string;
    error?: string;
  }>;
  download: () => Promise<{ ok: boolean; error?: string }>;
  cancel: () => Promise<{ ok: boolean }>;
  restart: () => Promise<void>;
  setConfig: (config: { autoDownload: boolean; channel: 'stable' | 'beta' }) => Promise<void>;
  /** Subscribe to status pushes; returns an unsubscribe fn (mirrors ai.onChunk). */
  onStatus: (callback: (status: UpdaterStatus) => void) => () => void;
}

interface ElectronWindowAPI {
  minimize: () => void;
  maximize: () => void;
  close: () => void;
  openNew: () => Promise<void>;
}

interface ElectronHttpProxyConfig {
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

interface ElectronHttpClientCert {
  format: 'pfx' | 'pem';
  pfx?: string;
  cert?: string;
  key?: string;
  passphrase?: ProtocolSecretValue;
}

interface ElectronHttpCaCert {
  pem: string;
}

interface ElectronHttpFormField {
  name: string;
  value: string;
  // `| undefined` (not bare `?`) so the Zod-inferred ProxyRequestBody.formData
  // assigns cleanly under exactOptionalPropertyTypes.
  filename?: string | undefined;
  contentType?: string | undefined;
}

interface ElectronHttpRequestConfig {
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

interface ElectronHttpResponse {
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

interface ElectronHttpAPI {
  request: (config: ElectronHttpRequestConfig) => Promise<ElectronHttpResponse>;
}

interface GrpcIpcResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  message?: unknown;
  messages?: unknown[];
  trailers: Record<string, string>;
  error?: string;
  details?: string;
}

interface GrpcReflectionConfig {
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

interface GrpcRawReflectionResponse {
  listServicesResponse?: { service: Array<{ name: string }> };
  fileDescriptorResponse?: { fileDescriptorProto: string[] };
  errorResponse?: { errorCode: number; errorMessage: string };
}

interface ElectronGrpcAPI {
  request: (config: unknown) => Promise<GrpcIpcResult>;
  reflect: (config: GrpcReflectionConfig) => Promise<GrpcRawReflectionResponse>;
  startStream: (config: unknown) => void;
  sendMessage: (requestId: string, message: unknown) => void;
  endStream: (requestId: string) => void;
  cancelStream: (requestId: string) => void;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
}

interface ElectronWebSocketAPI {
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

interface ElectronSseAPI {
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

interface SocketIoConnectIpcConfig {
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

interface SocketIoEmitIpcConfig {
  connectionId: string;
  eventName: string;
  args: unknown[];
  ackId?: string;
  ackTimeoutMs?: number;
}

interface ElectronSocketIoAPI {
  connect: (config: SocketIoConnectIpcConfig) => Promise<{ success: boolean; error?: string }>;
  emit: (config: SocketIoEmitIpcConfig) => Promise<{ success: boolean; error?: string }>;
  disconnect: (config: { connectionId: string }) => Promise<{ success: boolean }>;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeAllListeners: (channel: string) => void;
}

interface ElectronMcpAPI {
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

type KafkaSaslMechanism = 'PLAIN' | 'SCRAM-SHA-256' | 'SCRAM-SHA-512';

interface KafkaTlsIpc {
  ca?: string;
  cert?: string;
  key?: string;
  passphrase?: string;
  rejectUnauthorized?: boolean;
}

type KafkaAuthIpc =
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
interface KafkaRegistryIpc {
  url: string;
  auth?: { username?: string; password?: string; token?: string };
}

interface KafkaAck {
  topic: string;
  partition: number;
  offset: string;
  timestamp: number;
}

/** Per-partition starting offset for MANUAL consume mode (offset is a numeric string). */
interface KafkaPartitionOffset {
  topic: string;
  partition: number;
  offset: string;
}

/** A consumer group as returned by Admin.listGroups (Map flattened to an array). */
interface KafkaGroupInfo {
  id: string;
  state: string;
  groupType: string;
  protocolType: string;
}

/** Per-partition watermarks for a topic (offsets are numeric strings). */
interface KafkaPartitionWatermark {
  partition: number;
  low: string;
  high: string;
  count: string;
}

/** A single topic config entry (Admin.describeConfigs, flattened). */
interface KafkaTopicConfigEntry {
  name: string;
  value: string | null;
  source: string;
  isDefault: boolean;
  isSensitive: boolean;
  readOnly: boolean;
}

/** A consumer-group member with its partition assignments. */
interface KafkaGroupMemberInfo {
  memberId: string;
  clientId: string;
  clientHost: string;
  assignments: { topic: string; partitions: number[] }[];
}

/** A consumer group's describe output (Admin.describeGroups, flattened). */
interface KafkaGroupDescription {
  id: string;
  state: string;
  protocol: string;
  protocolType: string;
  members: KafkaGroupMemberInfo[];
}

/** Per-partition committed offset + log-end + computed lag for a group. */
interface KafkaPartitionLag {
  topic: string;
  partition: number;
  /** Committed offset, or null when the group has not committed this partition. */
  committed: string | null;
  logEnd: string;
  lag: string;
}

interface ElectronKafkaAPI {
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
type MqttProtocolVersion = 4 | 5; // 4 = MQTT 3.1.1, 5 = MQTT 5.0
type MqttQoS = 0 | 1 | 2;

interface MqttTlsIpc {
  ca?: string;
  cert?: string;
  key?: string;
  passphrase?: string;
  rejectUnauthorized?: boolean;
}

interface MqttLwtIpc {
  topic: string;
  payload: string;
  qos: MqttQoS;
  retain: boolean;
}

interface MqttConnectIpc {
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

interface MqttPublishIpc {
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

interface MqttPublishAck {
  topic: string;
  qos: MqttQoS;
  packetId?: number;
  reasonCode?: number;
  timestamp: number;
}

interface ElectronMqttAPI {
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

interface ElectronNotificationAPI {
  isSupported: () => Promise<boolean>;
  show: (options: {
    title: string;
    body: string;
    silent?: boolean;
    urgency?: 'normal' | 'critical' | 'low';
  }) => Promise<{ success: boolean }>;
  requestComplete: (data: {
    status: number;
    time: number;
    url: string;
  }) => Promise<{ success: boolean }>;
  updateAvailable: (version: string) => Promise<{ success: boolean }>;
  error: (message: string) => Promise<{ success: boolean }>;
}

interface ElectronStoreAPI {
  get: (key: string) => Promise<string | undefined>;
  set: (key: string, value: string) => Promise<void>;
  delete: (key: string) => Promise<void>;
  clear: () => Promise<void>;
  has: (key: string) => Promise<boolean>;
}

/**
 * Git operations for file-backed collections (read plus staging, commit, and
 * local branch create/checkout; remote push/pull not yet exposed). All
 * operations are gated main-side by collection-manager's directory allowlist.
 */
interface ElectronGitAPI {
  init: (
    directoryPath: string
  ) => Promise<{ ok: true; initialized: true } | { ok: false; error: string }>;
  status: (directoryPath: string) => Promise<
    | {
        ok: true;
        status: {
          files: Array<{ path: string; staged: string; unstaged: string }>;
          branch: string | null;
          ahead: number;
          behind: number;
          clean: boolean;
        };
      }
    // `code` carries a stable GitError code (e.g. 'not-a-repo') so callers can
    // branch without string-matching git's localized error message.
    | { ok: false; error: string; code?: string }
  >;
  log: (
    directoryPath: string,
    limit?: number
  ) => Promise<
    | {
        ok: true;
        commits: Array<{
          sha: string;
          abbreviatedSha: string;
          author: string;
          email: string;
          timestamp: number;
          subject: string;
        }>;
      }
    | { ok: false; error: string }
  >;
  diff: (
    directoryPath: string,
    filePath: string
  ) => Promise<{ ok: true; diff: string } | { ok: false; error: string }>;
  branchList: (directoryPath: string) => Promise<
    | {
        ok: true;
        branches: Array<{ name: string; isCurrent: boolean; isRemote: boolean; upstream?: string }>;
      }
    | { ok: false; error: string }
  >;
  add: (
    directoryPath: string,
    filePaths: string[]
  ) => Promise<{ ok: true; staged: true } | { ok: false; error: string }>;
  commit: (
    directoryPath: string,
    message: string,
    options?: { all?: boolean; paths?: string[] }
  ) => Promise<
    { ok: true; commit: { sha: string; abbreviatedSha: string } } | { ok: false; error: string }
  >;
  createBranch: (
    directoryPath: string,
    name: string
  ) => Promise<{ ok: true; branch: string } | { ok: false; error: string }>;
  checkoutBranch: (
    directoryPath: string,
    name: string
  ) => Promise<{ ok: true; branch: string } | { ok: false; error: string }>;
}

interface ElectronMockStatus {
  running: boolean;
  port?: number;
  baseUrl?: string;
  collectionId?: string;
  routeCount?: number;
}

interface ElectronMockRoute {
  method: string;
  path: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyEncoding?: 'base64';
  delayMs?: number;
}

interface ElectronMockAPI {
  start: (config: {
    collectionId: string;
    port?: number;
    routes: ElectronMockRoute[];
  }) => Promise<{ ok: true; status: ElectronMockStatus } | { ok: false; error: string }>;
  stop: () => Promise<{ ok: true; status: ElectronMockStatus } | { ok: false; error: string }>;
  status: () => Promise<{ ok: true; status: ElectronMockStatus } | { ok: false; error: string }>;
}

export interface ElectronCaptureBridgeStatus {
  running: boolean;
  port?: number;
}

interface ElectronCaptureAPI {
  startBridge: () => Promise<
    { ok: true; status: ElectronCaptureBridgeStatus; token?: string } | { ok: false; error: string }
  >;
  stopBridge: () => Promise<
    { ok: true; status: ElectronCaptureBridgeStatus } | { ok: false; error: string }
  >;
  bridgeStatus: () => Promise<
    { ok: true; status: ElectronCaptureBridgeStatus } | { ok: false; error: string }
  >;
  // A captured session arrived over the loopback bridge, already converted to an
  // OpenCollection document the renderer should confirm-and-import.
  onReceived: (callback: (doc: unknown) => void) => void;
  removeReceivedListener: () => void;
}

interface LogEntry {
  ts: number;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  protocol: 'http' | 'grpc';
  error?: string;
}

interface ElectronLogAPI {
  getHistory: (limit?: number) => Promise<LogEntry[]>;
  clear: () => Promise<void>;
}

interface KeychainStatus {
  mode: 'safeStorage' | 'plaintext';
  reason?: 'no-keyring' | 'decrypt-failed';
  plaintextStores: string[];
  lastChecked: string;
}

interface ElectronKeychainAPI {
  status: () => Promise<KeychainStatus>;
  rotate: () => Promise<{
    rotated: boolean;
    status: KeychainStatus;
    /** Free-text explanation from main when `rotated: false`. */
    reason?: string;
  }>;
}

interface FileChangedEvent {
  type: 'modified' | 'added' | 'deleted';
  filePath: string;
  directoryPath: string;
  lastModified?: number;
}

interface ElectronCollectionsAPI {
  loadFromDirectory: (
    path: string
  ) => Promise<{ success: boolean; collection?: unknown; error?: string }>;
  saveToDirectory: (
    collection: unknown,
    path: string
  ) => Promise<{ success: boolean; error?: string }>;
  saveBrunoToDirectory: (
    entries: Array<{ relativePath: string; content: string }>,
    path: string
  ) => Promise<{ success: boolean; error?: string }>;
  watchDirectory: (path: string) => Promise<{ success: boolean; error?: string }>;
  unwatchDirectory: (path: string) => Promise<{ success: boolean }>;
  selectDirectory: () => Promise<{ canceled: boolean; filePaths?: string[] }>;
  openInExplorer: (path: string) => Promise<{ success: boolean; error?: string }>;
  getFileInfo: (
    filePath: string
  ) => Promise<{ exists: boolean; lastModified?: number; size?: number }>;
  onFileChanged: (callback: (event: FileChangedEvent) => void) => void;
  removeFileChangedListener: () => void;
}

interface ElectronSecretHandleDescriptor {
  label?: string;
  scope?: string;
  createdAt: number;
}

interface ElectronSecretHandleSummary extends ElectronSecretHandleDescriptor {
  id: string;
}

/**
 * Renderer-callable IPC for the SecretRef pattern (ADR-0007). `resolve` is
 * deliberately absent — handles are resolved main-side only.
 *
 * `describe` (single) and `list` (many) are split channels so the renderer
 * always knows which return shape it's getting without inspecting key
 * presence on a union.
 */
interface ElectronSecretsAPI {
  store: (args: {
    value: string;
    label?: string;
    scope?: string;
    id?: string;
  }) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  delete: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  describe: (
    id: string
  ) => Promise<
    { ok: true; handle: ElectronSecretHandleDescriptor | null } | { ok: false; error: string }
  >;
  list: () => Promise<
    { ok: true; handles: ElectronSecretHandleSummary[] } | { ok: false; error: string }
  >;
}

interface ElectronVaultAPI {
  get: (key: string) => Promise<{ value: string | null }>;
  set: (key: string, value: string) => Promise<{ ok: true }>;
  unset: (key: string) => Promise<{ ok: true }>;
}

interface ElectronAiAPI {
  chat: (spec: {
    streamId: string;
    provider: 'openai' | 'anthropic' | 'openrouter' | 'openai-compatible';
    model: string;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    apiKeyHandleId?: string;
    baseUrlOverride?: string;
    rawMode: boolean;
    maxOutputTokens?: number;
    tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  }) => Promise<{ ok: true; streamId: string } | { ok: false; error: string }>;
  cancel: (args: {
    streamId: string;
  }) => Promise<{ ok: boolean; alreadyDone?: boolean; error?: string }>;
  onChunk: (
    streamId: string,
    cb: (event: import('../../shared/protocol/ai/types').ChatStreamEvent) => void
  ) => () => void;
  onEnd: (
    streamId: string,
    cb: (payload: { reason: 'done' | 'cancelled' | 'error' }) => void
  ) => () => void;
}

/**
 * AI Lab (Electron-only). Superset of the chat providers — adds local runtimes
 * (Ollama, generic OpenAI-compatible) and a non-streaming `complete` for evals /
 * LLM-as-judge. See electron/main/handlers/ai-lab-handler.ts.
 */
interface AiLabModelSpec {
  provider: import('../../shared/protocol/ai/types').Provider;
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  apiKeyHandleId?: string;
  baseUrlOverride?: string;
  rawMode: boolean;
  maxOutputTokens?: number;
  tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
}

interface AiLabDiscoverArgs {
  provider: import('../../shared/protocol/ai/types').Provider;
  baseUrl: string;
  apiKeyHandleId?: string;
}

interface ElectronAiLabAPI {
  complete: (
    spec: AiLabModelSpec
  ) => Promise<
    | { ok: true; result: import('../../shared/protocol/ai/types').CompletionResult }
    | { ok: false; error: string }
  >;
  stream: (
    spec: AiLabModelSpec & { streamId: string }
  ) => Promise<{ ok: true; streamId: string } | { ok: false; error: string }>;
  cancelStream: (args: {
    streamId: string;
  }) => Promise<{ ok: boolean; alreadyDone?: boolean; error?: string }>;
  listModels: (
    args: AiLabDiscoverArgs
  ) => Promise<
    | { ok: true; models: import('../../shared/protocol/ai/model-discovery').DiscoveredModel[] }
    | { ok: false; error: string }
  >;
  testConnection: (
    args: AiLabDiscoverArgs
  ) => Promise<{ ok: true; modelCount: number } | { ok: false; error: string }>;
  onChunk: (
    streamId: string,
    cb: (event: import('../../shared/protocol/ai/types').ChatStreamEvent) => void
  ) => () => void;
  onEnd: (
    streamId: string,
    cb: (payload: { reason: 'done' | 'cancelled' | 'error' }) => void
  ) => () => void;
}

interface ElectronTelemetryAPI {
  /** Push the renderer's opt-in flag to main; gates Sentry crash/error reporting. */
  setConsent: (enabled: boolean) => Promise<{ ok: true }>;
}

interface ElectronSecurityAPI {
  /** Push the outbound-network policy to main; shared by every SSRF guard. */
  setNetworkPolicy: (policy: {
    allowLocalhost: boolean;
    allowPrivateIPs: boolean;
  }) => Promise<{ ok: true }>;
}

interface ElectronAPI {
  platform: NodeJS.Platform;
  isElectron: boolean;
  dialog: ElectronDialogAPI;
  fs: ElectronFSAPI;
  app: ElectronAppAPI;
  updater: ElectronUpdaterAPI;
  shell: ElectronShellAPI;
  window: ElectronWindowAPI;
  http: ElectronHttpAPI;
  grpc: ElectronGrpcAPI;
  websocket: ElectronWebSocketAPI;
  socketio: ElectronSocketIoAPI;
  sse: ElectronSseAPI;
  mcp: ElectronMcpAPI;
  kafka: ElectronKafkaAPI;
  mqtt: ElectronMqttAPI;
  notification: ElectronNotificationAPI;
  store: ElectronStoreAPI;
  git: ElectronGitAPI;
  mock: ElectronMockAPI;
  capture: ElectronCaptureAPI;
  secrets: ElectronSecretsAPI;
  vault: ElectronVaultAPI;
  ai: ElectronAiAPI;
  aiLab: ElectronAiLabAPI;
  log: ElectronLogAPI;
  keychain: ElectronKeychainAPI;
  collections: ElectronCollectionsAPI;
  telemetry: ElectronTelemetryAPI;
  security: ElectronSecurityAPI;
  // Valid channels are enumerated by VALID_EVENT_CHANNELS in electron/shared/channels.ts:
  // 'menu:import' | 'menu:export' | 'menu:new-request' | 'menu:settings' | 'app:focus'
  // | 'app:check-updates' | 'deep-link'.
  // 'deep-link' callback receives: { host: string; params: Record<string, string> }
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
}

declare global {
  interface Window {
    electron?: ElectronAPI;
  }
}

export type {
  ElectronAPI,
  ElectronDialogAPI,
  ElectronFSAPI,
  ElectronAppAPI,
  ElectronShellAPI,
  ElectronUpdaterAPI,
  UpdaterStatus,
  ElectronWindowAPI,
  ElectronNotificationAPI,
  ElectronGitAPI,
  ElectronMockAPI,
  ElectronLogAPI,
  ElectronKeychainAPI,
  KeychainStatus,
  ElectronCollectionsAPI,
  ElectronHttpRequestConfig,
  ElectronHttpResponse,
  ElectronGrpcAPI,
  ElectronSseAPI,
  ElectronMcpAPI,
  ElectronKafkaAPI,
  ElectronSecretsAPI,
  ElectronSecretHandleDescriptor,
  ElectronSecretHandleSummary,
  KafkaAuthIpc,
  KafkaTlsIpc,
  KafkaSaslMechanism,
  KafkaRegistryIpc,
  KafkaAck,
  KafkaPartitionOffset,
  KafkaGroupInfo,
  KafkaPartitionWatermark,
  KafkaTopicConfigEntry,
  KafkaGroupMemberInfo,
  KafkaGroupDescription,
  KafkaPartitionLag,
  ElectronMqttAPI,
  MqttConnectIpc,
  MqttPublishIpc,
  MqttPublishAck,
  MqttTlsIpc,
  MqttLwtIpc,
  MqttProtocolVersion,
  MqttQoS,
  GrpcIpcResult,
  FileChangedEvent,
  LogEntry,
  ElectronAiAPI,
  ElectronAiLabAPI,
  AiLabModelSpec,
  AiLabDiscoverArgs,
};
