/**
 * Typed IPC utilities for secure Electron communication
 * Provides type-safe wrappers around the Electron IPC API
 */

import type { ElectronAPI } from '../../../electron/types/electron.d';

// ============================================================================
// IPC Channel Definitions
// ============================================================================

/**
 * IPC invoke channels (request/response pattern)
 */
export type IPCInvokeChannels = {
  // Dialog operations
  'dialog:openFile': {
    params: {
      title?: string;
      defaultPath?: string;
      filters?: Array<{ name: string; extensions: string[] }>;
      properties?: Array<'openFile' | 'openDirectory' | 'multiSelections'>;
    } | undefined;
    result: { canceled: boolean; filePaths: string[] };
  };
  'dialog:saveFile': {
    params: {
      title?: string;
      defaultPath?: string;
      filters?: Array<{ name: string; extensions: string[] }>;
    } | undefined;
    result: { canceled: boolean; filePath?: string };
  };

  // File system operations
  'fs:readFile': {
    params: string;
    result: { success: boolean; content?: string; error?: string };
  };
  'fs:writeFile': {
    params: { filePath: string; content: string };
    result: { success: boolean; error?: string };
  };

  // App operations
  'app:getPath': {
    params:
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
      | 'crashDumps';
    result: string;
  };
  'app:getVersion': {
    params: void;
    result: string;
  };
  'app:checkForUpdates': {
    params: void;
    result: { updateAvailable: boolean; version?: string; message?: string; error?: string };
  };

  // Shell operations
  'shell:openExternal': {
    params: string;
    result: void;
  };

  // HTTP operations
  'http:request': {
    params: {
      method: string;
      url: string;
      headers?: Record<string, string>;
      params?: Record<string, string>;
      data?: string;
      timeout?: number;
      maxRedirects?: number;
      proxy?: {
        enabled: boolean;
        type: string;
        host: string;
        port: number;
        auth?: { username: string; password: string };
      };
      verifySsl?: boolean;
    };
    result: {
      status: number;
      statusText: string;
      headers: Record<string, string>;
      data: unknown;
    };
  };

  // gRPC operations
  'grpc:request': {
    params: unknown;
    result: unknown;
  };

  // Notification operations
  'notification:isSupported': {
    params: void;
    result: boolean;
  };
  'notification:show': {
    params: {
      title: string;
      body: string;
      silent?: boolean;
      urgency?: 'normal' | 'critical' | 'low';
    };
    result: { success: boolean };
  };
};

/**
 * IPC send channels (fire and forget)
 */
export type IPCSendChannels = {
  'window:minimize': void;
  'window:maximize': void;
  'window:close': void;
  'grpc:start-stream': unknown;
  'grpc:send-message': { requestId: string; message: unknown };
  'grpc:end-stream': string;
  'grpc:cancel-stream': string;
};

/**
 * IPC event channels (main -> renderer)
 */
export type IPCEventChannels = {
  'menu:import': void;
  'menu:export': void;
  'menu:new-request': void;
  'app:focus': void;
  'update:checking': void;
  'update:available': { version: string; releaseNotes?: string };
  'update:not-available': void;
  'update:error': string;
  'update:progress': number;
  'update:ready': void;
  'grpc:stream-data': { requestId: string; data: unknown };
  'grpc:stream-end': { requestId: string };
  'grpc:stream-error': { requestId: string; error: string };
};

// ============================================================================
// IPC Utilities
// ============================================================================

/**
 * Get the Electron API safely
 */
export function getElectronAPI(): ElectronAPI | null {
  if (typeof window === 'undefined') return null;
  return window.electron ?? null;
}

/**
 * Check if running in Electron
 */
export function isElectron(): boolean {
  return getElectronAPI()?.isElectron === true;
}

/**
 * Type-safe IPC invoke wrapper
 */
export async function ipcInvoke<K extends keyof IPCInvokeChannels>(
  channel: K,
  params: IPCInvokeChannels[K]['params']
): Promise<IPCInvokeChannels[K]['result']> {
  const api = getElectronAPI();
  if (!api) {
    throw new Error(`IPC not available: ${channel}`);
  }

  // Route to appropriate API method based on channel
  switch (channel) {
    case 'dialog:openFile':
      return api.dialog.openFile(params as IPCInvokeChannels['dialog:openFile']['params']) as Promise<IPCInvokeChannels[K]['result']>;
    case 'dialog:saveFile':
      return api.dialog.saveFile(params as IPCInvokeChannels['dialog:saveFile']['params']) as Promise<IPCInvokeChannels[K]['result']>;
    case 'fs:readFile':
      return api.fs.readFile(params as string) as Promise<IPCInvokeChannels[K]['result']>;
    case 'fs:writeFile': {
      const p = params as IPCInvokeChannels['fs:writeFile']['params'];
      return api.fs.writeFile(p.filePath, p.content) as Promise<IPCInvokeChannels[K]['result']>;
    }
    case 'app:getPath':
      return api.app.getPath(params as IPCInvokeChannels['app:getPath']['params']) as Promise<IPCInvokeChannels[K]['result']>;
    case 'app:getVersion':
      return api.app.getVersion() as Promise<IPCInvokeChannels[K]['result']>;
    case 'app:checkForUpdates':
      return api.app.checkForUpdates() as Promise<IPCInvokeChannels[K]['result']>;
    case 'shell:openExternal':
      return api.shell.openExternal(params as string) as Promise<IPCInvokeChannels[K]['result']>;
    case 'http:request':
      return api.http.request(params as IPCInvokeChannels['http:request']['params']) as Promise<IPCInvokeChannels[K]['result']>;
    case 'grpc:request':
      return api.grpc.request(params) as Promise<IPCInvokeChannels[K]['result']>;
    default:
      throw new Error(`Unknown IPC channel: ${channel}`);
  }
}

/**
 * Type-safe IPC send wrapper (fire and forget)
 */
export function ipcSend<K extends keyof IPCSendChannels>(
  channel: K,
  ..._args: IPCSendChannels[K] extends void ? [] : [IPCSendChannels[K]]
): void {
  const api = getElectronAPI();
  if (!api) return;

  switch (channel) {
    case 'window:minimize':
      api.window.minimize();
      break;
    case 'window:maximize':
      api.window.maximize();
      break;
    case 'window:close':
      api.window.close();
      break;
    case 'grpc:start-stream':
      api.grpc.startStream(_args[0]);
      break;
    case 'grpc:send-message': {
      const data = _args[0] as IPCSendChannels['grpc:send-message'];
      api.grpc.sendMessage(data.requestId, data.message);
      break;
    }
    case 'grpc:end-stream':
      api.grpc.endStream(_args[0] as string);
      break;
    case 'grpc:cancel-stream':
      api.grpc.cancelStream(_args[0] as string);
      break;
  }
}

/**
 * Type-safe IPC event listener
 * Returns cleanup function
 */
export function ipcOn<K extends keyof IPCEventChannels>(
  channel: K,
  callback: (data: IPCEventChannels[K]) => void
): () => void {
  const api = getElectronAPI();
  if (!api) {
    return () => {};
  }

  const wrappedCallback = (data: unknown) => callback(data as IPCEventChannels[K]);

  if (channel.startsWith('grpc:')) {
    api.grpc.on(channel, wrappedCallback);
    return () => api.grpc.removeListener(channel, wrappedCallback);
  }

  api.on(channel, wrappedCallback);
  return () => api.removeListener(channel, wrappedCallback);
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Open a file dialog
 */
export async function openFileDialog(options?: IPCInvokeChannels['dialog:openFile']['params']) {
  if (!isElectron()) {
    // Web fallback using input element
    return new Promise<{ canceled: boolean; filePaths: string[] }>((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      if (options?.filters) {
        const extensions = options.filters.flatMap((f) => f.extensions.map((ext) => `.${ext}`));
        input.accept = extensions.join(',');
      }
      if (options?.properties?.includes('multiSelections')) {
        input.multiple = true;
      }
      input.onchange = () => {
        const files = input.files;
        if (files && files.length > 0) {
          resolve({
            canceled: false,
            filePaths: Array.from(files).map((f) => f.name),
          });
        } else {
          resolve({ canceled: true, filePaths: [] });
        }
      };
      input.click();
    });
  }
  return ipcInvoke('dialog:openFile', options);
}

/**
 * Save file dialog
 */
export async function saveFileDialog(options?: IPCInvokeChannels['dialog:saveFile']['params']) {
  if (!isElectron()) {
    return { canceled: false, filePath: options?.defaultPath || 'download' };
  }
  return ipcInvoke('dialog:saveFile', options);
}

/**
 * Read file from disk
 */
export async function readFile(filePath: string) {
  if (!isElectron()) {
    return { success: false, error: 'File system not available in web mode' };
  }
  return ipcInvoke('fs:readFile', filePath);
}

/**
 * Write file to disk
 */
export async function writeFile(filePath: string, content: string) {
  if (!isElectron()) {
    return { success: false, error: 'File system not available in web mode' };
  }
  return ipcInvoke('fs:writeFile', { filePath, content });
}

/**
 * Open external URL
 */
export async function openExternal(url: string) {
  if (!isElectron()) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  return ipcInvoke('shell:openExternal', url);
}

/**
 * Get app version
 */
export async function getAppVersion(): Promise<string> {
  if (!isElectron()) {
    return import.meta.env.VITE_APP_VERSION || '0.1.0';
  }
  return ipcInvoke('app:getVersion', undefined);
}
