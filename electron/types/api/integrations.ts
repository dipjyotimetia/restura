export interface ElectronNotificationAPI {
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

export interface ElectronStoreAPI {
  get: (key: string) => Promise<string | undefined>;
  set: (key: string, value: string) => Promise<void>;
  delete: (key: string) => Promise<void>;
  clear: () => Promise<void>;
  has: (key: string) => Promise<boolean>;
}

/**
 * Git operations for file-backed collections (read plus staging, commit, and
 * local branch create/checkout and scoped remote sync). All
 * operations are gated main-side by collection-manager's directory allowlist.
 */
export interface ElectronGitAPI {
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
    filePath: string,
    staged?: boolean
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
  unstage: (
    directoryPath: string,
    filePaths: string[]
  ) => Promise<{ ok: true; unstaged: true } | { ok: false; error: string }>;
  /** Discards only renderer-confirmed files. */
  discard: (
    directoryPath: string,
    filePaths: string[]
  ) => Promise<{ ok: true; discarded: true } | { ok: false; error: string }>;
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
  fetch: (
    directoryPath: string
  ) => Promise<
    { ok: true; remote: { remote: string } } | { ok: false; error: string; code?: string }
  >;
  pull: (
    directoryPath: string
  ) => Promise<
    { ok: true; result: { updated: boolean } } | { ok: false; error: string; code?: string }
  >;
  push: (
    directoryPath: string
  ) => Promise<
    | { ok: true; result: { remote: string; branch: string } }
    | { ok: false; error: string; code?: string }
  >;
  clone: (
    parentDirectory: string,
    remoteUrl: string,
    directoryName: string
  ) => Promise<
    { ok: true; workspace: { directoryPath: string } } | { ok: false; error: string; code?: string }
  >;
}

export interface ElectronMockStatus {
  running: boolean;
  port?: number;
  baseUrl?: string;
  collectionId?: string;
  routeCount?: number;
}

export interface ElectronMockRoute {
  method: string;
  path: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyEncoding?: 'base64';
  delayMs?: number;
}

export interface ElectronMockAPI {
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

export interface ElectronCaptureAPI {
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

export interface LogEntry {
  ts: number;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  protocol: 'http' | 'grpc';
  error?: string;
}

export interface ElectronLogAPI {
  getHistory: (limit?: number) => Promise<LogEntry[]>;
  clear: () => Promise<void>;
}

export interface KeychainStatus {
  mode: 'safeStorage' | 'plaintext';
  reason?: 'no-keyring' | 'decrypt-failed';
  plaintextStores: string[];
  lastChecked: string;
}

export interface ElectronKeychainAPI {
  status: () => Promise<KeychainStatus>;
  rotate: () => Promise<{
    rotated: boolean;
    status: KeychainStatus;
    /** Free-text explanation from main when `rotated: false`. */
    reason?: string;
  }>;
}

export interface FileChangedEvent {
  type: 'modified' | 'added' | 'deleted';
  filePath: string;
  directoryPath: string;
  lastModified?: number;
}

export interface ElectronCollectionsAPI {
  loadFromDirectory: (path: string) => Promise<{
    success: boolean;
    collection?: unknown;
    error?: string;
  }>;
  saveToDirectory: (
    collection: unknown,
    path: string
  ) => Promise<{ success: boolean; error?: string }>;
  saveBrunoToDirectory: (
    entries: Array<{ relativePath: string; content: string }>,
    path: string
  ) => Promise<{ success: boolean; error?: string }>;
  watchDirectory: (path: string) => Promise<{ success: boolean; error?: string }>;
  unwatchDirectory: (path: string) => Promise<{ success: boolean; error?: string }>;
  selectDirectory: () => Promise<{ canceled: boolean; filePaths?: string[] }>;
  openInExplorer: (path: string) => Promise<{ success: boolean; error?: string }>;
  getFileInfo: (
    filePath: string
  ) => Promise<{ exists: boolean; lastModified?: number; size?: number; error?: string }>;
  onFileChanged: (callback: (event: FileChangedEvent) => void) => void;
  removeFileChangedListener: () => void;
}

export interface ElectronOwsWorkspaceAPI {
  list: (
    directoryPath: string
  ) => Promise<{ ok: true; workflowIds: string[] } | { ok: false; error: string }>;
  load: (
    directoryPath: string,
    workflowId: string
  ) => Promise<
    | {
        ok: true;
        artifact: {
          workflow: import('../../../shared/ows/workflow-profile').OwsWorkflow;
          bindings: import('../../../shared/ows/bindings').OwsBindings;
          layout: import('../../../shared/ows/bindings').OwsLayout;
        };
      }
    | { ok: false; error: string }
  >;
  save: (
    directoryPath: string,
    workflowId: string,
    artifact: {
      workflow: import('../../../shared/ows/workflow-profile').OwsWorkflow;
      bindings: import('../../../shared/ows/bindings').OwsBindings;
      layout: import('../../../shared/ows/bindings').OwsLayout;
    }
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  delete: (
    directoryPath: string,
    workflowId: string
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface ElectronSecretHandleDescriptor {
  label?: string;
  scope?: string;
  createdAt: number;
}

export interface ElectronSecretHandleSummary extends ElectronSecretHandleDescriptor {
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
export interface ElectronSecretsAPI {
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
  clear: () => Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface ElectronVaultAPI {
  get: (key: string) => Promise<{ value: string | null }>;
  set: (key: string, value: string) => Promise<{ ok: true }>;
  unset: (key: string) => Promise<{ ok: true }>;
  clear: () => Promise<{ ok: true }>;
}

export interface ElectronAiAPI {
  chat: (spec: {
    streamId: string;
    provider: 'openai' | 'anthropic' | 'openrouter' | 'openai-compatible';
    model: string;
    messages: Array<{
      role: 'system' | 'user' | 'assistant' | 'tool';
      content: string;
      toolCallId?: string;
      toolCalls?: Array<{ id: string; name: string; input: string }>;
    }>;
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
    cb: (event: import('../../../shared/protocol/ai/types').ChatStreamEvent) => void
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
export interface AiLabModelSpec {
  provider: import('../../../shared/protocol/ai/types').Provider;
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    toolCallId?: string;
    toolCalls?: Array<{ id: string; name: string; input: string }>;
  }>;
  apiKeyHandleId?: string;
  baseUrlOverride?: string;
  rawMode: boolean;
  maxOutputTokens?: number;
  tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
}

export interface AiLabDiscoverArgs {
  provider: import('../../../shared/protocol/ai/types').Provider;
  baseUrl: string;
  apiKeyHandleId?: string;
  /** Plaintext key for the pre-add discovery path (see AiLabDiscoverSchema). */
  apiKey?: string;
}

export interface ElectronAiLabAPI {
  exportTelemetry: (args: {
    config: import('../../../shared/agent-lab/telemetry-config').AgentTelemetryConfig;
    trace: import('../../../shared/agent-lab/telemetry').TelemetryTrace;
  }) => Promise<
    | {
        ok: true;
        delivery: {
          id: string;
          status: 'disabled' | 'queued' | 'sent' | 'failed';
          error?: string;
        };
      }
    | { ok: false; error: string }
  >;
  complete: (
    spec: AiLabModelSpec & { operationId: string }
  ) => Promise<
    | { ok: true; result: import('../../../shared/protocol/ai/types').CompletionResult }
    | { ok: false; error: string }
  >;
  cancelComplete: (args: {
    operationId: string;
  }) => Promise<{ ok: boolean; alreadyDone?: boolean; error?: string }>;
  stream: (
    spec: AiLabModelSpec & { streamId: string }
  ) => Promise<{ ok: true; streamId: string } | { ok: false; error: string }>;
  cancelStream: (args: {
    streamId: string;
  }) => Promise<{ ok: boolean; alreadyDone?: boolean; error?: string }>;
  listModels: (
    args: AiLabDiscoverArgs
  ) => Promise<
    | { ok: true; models: import('../../../shared/protocol/ai/model-discovery').DiscoveredModel[] }
    | { ok: false; error: string }
  >;
  testConnection: (
    args: AiLabDiscoverArgs
  ) => Promise<{ ok: true; modelCount: number } | { ok: false; error: string }>;
  onChunk: (
    streamId: string,
    cb: (event: import('../../../shared/protocol/ai/types').ChatStreamEvent) => void
  ) => () => void;
  onEnd: (
    streamId: string,
    cb: (payload: { reason: 'done' | 'cancelled' | 'error' }) => void
  ) => () => void;
}

export interface ElectronTelemetryAPI {
  /** Push the renderer's opt-in flag to main; gates Sentry crash/error reporting. */
  setConsent: (enabled: boolean) => Promise<{ ok: true }>;
}

export interface ElectronSecurityAPI {
  /** Push the hydrated renderer policy to main before execution begins. */
  setExecutionPolicy: (policy: {
    security: { allowLocalhost: boolean; allowPrivateIPs: boolean };
    proxy: {
      enabled: boolean;
      type: 'none' | 'http' | 'https' | 'socks4' | 'socks5';
      host: string;
      port: number;
      bypassList: string[];
      auth?: { username: string; password: ProtocolSecretValue };
    };
    timeout: number;
    tls: {
      verifySsl: boolean;
      serverCipherOrder: boolean;
      minTlsVersion?: 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';
      cipherSuites?: string;
    };
    certificates: {
      clientCert?: {
        format: 'pfx' | 'pem';
        pfx?: string;
        cert?: string;
        key?: string;
        passphrase?: ProtocolSecretValue;
      };
      caCert?: { pem: string };
      clientCertificates: Array<{
        id: string;
        host: string;
        port?: number;
        cert: {
          format: 'pfx' | 'pem';
          pfx?: string;
          cert?: string;
          key?: string;
          passphrase?: ProtocolSecretValue;
        };
      }>;
      caCertificates: Array<{ id: string; host: string; port?: number; pem: string }>;
    };
  }) => Promise<{ ok: true }>;
}

export interface ElectronBugReportAPI {
  getDiagnostics: () => Promise<{
    appVersion: string;
    platform: 'electron' | 'web';
    operatingSystem: string;
    browser: string;
    route: string;
    capturedAt: string;
    runtimeErrors: Array<{ message: string; count: number; stack?: string }>;
    requestLogs: Array<{
      timestamp: string;
      protocol: string;
      method: string;
      url: string;
      status: number;
      durationMs: number;
      error?: string;
    }>;
  }>;
  captureScreenshot: () => Promise<
    { ok: true; imageDataUrl: string } | { ok: false; error: string }
  >;
  copyScreenshot: (imageDataUrl: string) => Promise<{ ok: true } | { ok: false; error: string }>;
}

import type { ProtocolSecretValue } from './protocols';
