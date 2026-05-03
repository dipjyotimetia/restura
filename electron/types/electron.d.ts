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
}

interface ElectronHttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: unknown;
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
  store: ElectronStoreAPI;
  log: ElectronLogAPI;
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

export type { ElectronAPI, ElectronDialogAPI, ElectronFSAPI, ElectronAppAPI, ElectronShellAPI, ElectronWindowAPI, ElectronLogAPI, ElectronCollectionsAPI, ElectronGrpcAPI, GrpcIpcResult, FileChangedEvent, LogEntry };
