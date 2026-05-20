// Type definitions for the Electron API exposed via preload script

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
  getPath: (
    name:
      | 'home'
      | 'appData'
      | 'userData'
      | 'sessionData'
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

interface ElectronWindowAPI {
  minimize: () => void;
  maximize: () => void;
  close: () => void;
  openNew: () => Promise<void>;
}

interface ElectronHttpProxyConfig {
  enabled: boolean;
  type: 'http' | 'https' | 'socks5' | 'pac';
  host: string;
  port: number;
  pacUrl?: string;
  auth?: {
    username: string;
    password: string;
  };
}

interface ElectronHttpClientCert {
  pfx?: string;
  cert?: string;
  key?: string;
  passphrase?: string;
}

interface ElectronHttpCaCert {
  pem: string;
}

interface ElectronHttpRequestConfig {
  method: string;
  url: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  data?: string;
  timeout?: number;
  maxRedirects?: number;
  proxy?: ElectronHttpProxyConfig;
  verifySsl?: boolean;
  clientCert?: ElectronHttpClientCert;
  caCert?: ElectronHttpCaCert;
}

interface ElectronHttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: unknown;
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

interface KafkaAck {
  topic: string;
  partition: number;
  offset: string;
  timestamp: number;
}

interface ElectronKafkaAPI {
  connect: (config: {
    connectionId: string;
    clientId: string;
    bootstrapBrokers: string[];
    auth: KafkaAuthIpc;
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
  }) => Promise<{ success: boolean; ack?: KafkaAck; error?: string }>;
  subscribe: (config: {
    connectionId: string;
    groupId: string;
    topics: string[];
    fromBeginning: boolean;
  }) => Promise<{ success: boolean; error?: string }>;
  unsubscribe: (config: { connectionId: string }) => Promise<{ success: boolean; error?: string }>;
  disconnect: (config: { connectionId: string }) => Promise<{ success: boolean }>;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeAllListeners: (channel: string) => void;
}

interface ElectronStoreAPI {
  get: (key: string) => Promise<string | undefined>;
  set: (key: string, value: string) => Promise<void>;
  delete: (key: string) => Promise<void>;
  clear: () => Promise<void>;
  has: (key: string) => Promise<boolean>;
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
  rotate: () => Promise<{ rotated: boolean; status: KeychainStatus }>;
}

interface FileChangedEvent {
  type: 'modified' | 'added' | 'deleted';
  filePath: string;
  directoryPath: string;
  lastModified?: number;
}

interface ElectronCollectionsAPI {
  loadFromDirectory: (path: string) => Promise<{ success: boolean; collection?: unknown; error?: string }>;
  saveToDirectory: (collection: unknown, path: string) => Promise<{ success: boolean; error?: string }>;
  watchDirectory: (path: string) => Promise<{ success: boolean; error?: string }>;
  unwatchDirectory: (path: string) => Promise<{ success: boolean }>;
  selectDirectory: () => Promise<{ canceled: boolean; filePaths?: string[] }>;
  openInExplorer: (path: string) => Promise<{ success: boolean; error?: string }>;
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
    | { ok: true; handle: ElectronSecretHandleDescriptor | null }
    | { ok: false; error: string }
  >;
  list: () => Promise<
    | { ok: true; handles: ElectronSecretHandleSummary[] }
    | { ok: false; error: string }
  >;
}

interface ElectronAPI {
  platform: NodeJS.Platform;
  isElectron: boolean;
  dialog: ElectronDialogAPI;
  fs: ElectronFSAPI;
  app: ElectronAppAPI;
  shell: ElectronShellAPI;
  window: ElectronWindowAPI;
  http: ElectronHttpAPI;
  grpc: ElectronGrpcAPI;
  websocket: ElectronWebSocketAPI;
  socketio: ElectronSocketIoAPI;
  sse: ElectronSseAPI;
  mcp: ElectronMcpAPI;
  kafka: ElectronKafkaAPI;
  store: ElectronStoreAPI;
  secrets: ElectronSecretsAPI;
  log: ElectronLogAPI;
  keychain: ElectronKeychainAPI;
  collections: ElectronCollectionsAPI;
  // Valid channels: 'menu:import' | 'menu:export' | 'menu:new-request' | 'app:focus' | 'deep-link'
  // 'deep-link' callback receives: { host: string; params: Record<string, string> }
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
}

declare global {
  interface Window {
    electron?: ElectronAPI;
  }
}

export type { ElectronAPI, ElectronDialogAPI, ElectronFSAPI, ElectronAppAPI, ElectronShellAPI, ElectronWindowAPI, ElectronLogAPI, ElectronKeychainAPI, KeychainStatus, ElectronCollectionsAPI, ElectronGrpcAPI, ElectronSseAPI, ElectronMcpAPI, ElectronKafkaAPI, ElectronSecretsAPI, ElectronSecretHandleDescriptor, ElectronSecretHandleSummary, KafkaAuthIpc, KafkaTlsIpc, KafkaSaslMechanism, KafkaAck, GrpcIpcResult, FileChangedEvent, LogEntry };
