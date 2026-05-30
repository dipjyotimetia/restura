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

/**
 * Auto-updater state pushed main→renderer over EVENT.updaterStatus. Single
 * discriminated shape keyed on `state` — maps to one renderer state machine.
 */
interface UpdaterStatus {
  state:
    | 'idle'
    | 'checking'
    | 'not-available'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'error';
  /** Present for `available` / `downloaded`. */
  version?: string;
  /** Download completion 0–100, present for `downloading`. */
  percent?: number;
  /** Normalized release notes (string), present for `available` / `downloaded`. */
  releaseNotes?: string;
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
 * Git operations for file-backed collections. Read-only in v1. All operations
 * are gated main-side by collection-manager's directory allowlist.
 */
interface ElectronGitAPI {
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
    | { ok: false; error: string }
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
    provider: 'openai' | 'anthropic' | 'openrouter';
    model: string;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    apiKeyHandleId: string;
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
  notification: ElectronNotificationAPI;
  store: ElectronStoreAPI;
  git: ElectronGitAPI;
  mock: ElectronMockAPI;
  secrets: ElectronSecretsAPI;
  vault: ElectronVaultAPI;
  ai: ElectronAiAPI;
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
  KafkaAck,
  GrpcIpcResult,
  FileChangedEvent,
  LogEntry,
  ElectronAiAPI,
};
