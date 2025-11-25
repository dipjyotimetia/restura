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
}

interface ElectronHttpProxyConfig {
  enabled: boolean;
  type: string;
  host: string;
  port: number;
  auth?: {
    username: string;
    password: string;
  };
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

interface ElectronGrpcAPI {
  request: (config: unknown) => Promise<unknown>;
  startStream: (config: unknown) => void;
  sendMessage: (requestId: string, message: unknown) => void;
  endStream: (requestId: string) => void;
  cancelStream: (requestId: string) => void;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
}

interface ElectronStoreAPI {
  get: (key: string) => Promise<string | undefined>;
  set: (key: string, value: string) => Promise<void>;
  delete: (key: string) => Promise<void>;
  clear: () => Promise<void>;
  has: (key: string) => Promise<boolean>;
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
  store: ElectronStoreAPI;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
}

declare global {
  interface Window {
    electron?: ElectronAPI;
  }
}

export type { ElectronAPI, ElectronDialogAPI, ElectronFSAPI, ElectronAppAPI, ElectronShellAPI, ElectronWindowAPI };
