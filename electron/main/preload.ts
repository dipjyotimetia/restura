import { contextBridge, ipcRenderer } from 'electron';

const VALID_EVENT_CHANNELS = ['menu:import', 'menu:export', 'menu:new-request', 'app:focus', 'deep-link'];

// Define the API that will be exposed to the renderer process
const electronAPI = {
  // Platform information
  platform: process.platform,
  isElectron: true,

  // Dialog operations
  dialog: {
    openFile: (options?: {
      title?: string;
      defaultPath?: string;
      filters?: Array<{ name: string; extensions: string[] }>;
      properties?: Array<'openFile' | 'openDirectory' | 'multiSelections'>;
    }) => ipcRenderer.invoke('dialog:openFile', options),

    saveFile: (options?: {
      title?: string;
      defaultPath?: string;
      filters?: Array<{ name: string; extensions: string[] }>;
    }) => ipcRenderer.invoke('dialog:saveFile', options),
  },

  // File system operations
  fs: {
    readFile: (filePath: string): Promise<{ success: boolean; content?: string; error?: string }> =>
      ipcRenderer.invoke('fs:readFile', filePath),

    writeFile: (filePath: string, content: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('fs:writeFile', filePath, content),
  },

  // App information
  app: {
    getPath: (name: string): Promise<string> => ipcRenderer.invoke('app:getPath', name),
    getVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),
    checkForUpdates: (): Promise<{
      updateAvailable: boolean;
      version?: string;
      message?: string;
      error?: string;
    }> => ipcRenderer.invoke('app:checkForUpdates'),
  },

  // Shell operations
  shell: {
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),
  },

  // Window operations
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    openNew: () => ipcRenderer.invoke('window:new'),
  },

  // HTTP operations with proxy support
  http: {
    request: (config: {
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
        auth?: {
          username: string;
          password: string;
        };
      };
      verifySsl?: boolean;
    }): Promise<{
      status: number;
      statusText: string;
      headers: Record<string, string>;
      data: unknown;
    }> => ipcRenderer.invoke('http:request', config),
  },

  // gRPC operations
  grpc: {
    request: (config: unknown): Promise<unknown> => ipcRenderer.invoke('grpc:request', config),
    reflect: (config: unknown): Promise<unknown> => ipcRenderer.invoke('grpc:reflect', config),
    startStream: (config: unknown) => ipcRenderer.send('grpc:start-stream', config),
    sendMessage: (requestId: string, message: unknown) => ipcRenderer.send('grpc:send-message', requestId, message),
    endStream: (requestId: string) => ipcRenderer.send('grpc:end-stream', requestId),
    cancelStream: (requestId: string) => ipcRenderer.send('grpc:cancel-stream', requestId),
    on: (channel: string, callback: (...args: unknown[]) => void) => {
      if (channel.startsWith('grpc:')) {
        ipcRenderer.on(channel, (_event, ...args) => callback(...args));
      }
    },
    removeListener: (channel: string, callback: (...args: unknown[]) => void) => {
      if (channel.startsWith('grpc:')) {
        ipcRenderer.removeListener(channel, callback);
      }
    }
  },

  // WebSocket operations with custom header support
  websocket: {
    connect: (config: {
      connectionId: string;
      url: string;
      headers?: Record<string, string>;
      protocols?: string[];
    }): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('ws:connect', config),

    send: (config: {
      connectionId: string;
      message: string;
      binary?: boolean;
    }): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('ws:send', config),

    disconnect: (config: { connectionId: string }): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('ws:disconnect', config),

    on: (channel: string, callback: (...args: unknown[]) => void) => {
      if (channel.startsWith('ws:')) {
        ipcRenderer.on(channel, (_event, ...args) => callback(...args));
      }
    },

    removeListener: (channel: string, callback: (...args: unknown[]) => void) => {
      if (channel.startsWith('ws:')) {
        ipcRenderer.removeListener(channel, callback);
      }
    },

    removeAllListeners: (channel: string) => {
      if (channel.startsWith('ws:')) {
        ipcRenderer.removeAllListeners(channel);
      }
    },
  },

  // SSE (Server-Sent Events) operations
  sse: {
    connect: (config: {
      connectionId: string;
      url: string;
      headers?: Record<string, string>;
    }): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('sse:connect', config),

    disconnect: (config: { connectionId: string }): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('sse:disconnect', config),

    on: (channel: string, callback: (...args: unknown[]) => void) => {
      if (channel.startsWith('sse:')) {
        ipcRenderer.on(channel, (_event, ...args) => callback(...args));
      }
    },

    removeListener: (channel: string, callback: (...args: unknown[]) => void) => {
      if (channel.startsWith('sse:')) {
        ipcRenderer.removeListener(channel, callback);
      }
    },

    removeAllListeners: (channel: string) => {
      if (channel.startsWith('sse:')) {
        ipcRenderer.removeAllListeners(channel);
      }
    },
  },

  // MCP (Model Context Protocol) operations
  mcp: {
    connect: (config: {
      connectionId: string;
      url: string;
      transport: 'streamable-http' | 'http-sse';
      headers?: Record<string, string>;
    }): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('mcp:connect', config),

    request: (config: {
      connectionId: string;
      method: string;
      params?: unknown;
      requestId?: string | number;
      timeout?: number;
    }): Promise<{ success: boolean; result?: unknown; error?: string; jsonRpcError?: { code: number; message: string; data?: unknown } }> =>
      ipcRenderer.invoke('mcp:request', config),

    disconnect: (config: { connectionId: string }): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('mcp:disconnect', config),

    on: (channel: string, callback: (...args: unknown[]) => void) => {
      if (channel.startsWith('mcp:')) {
        ipcRenderer.on(channel, (_event, ...args) => callback(...args));
      }
    },

    removeListener: (channel: string, callback: (...args: unknown[]) => void) => {
      if (channel.startsWith('mcp:')) {
        ipcRenderer.removeListener(channel, callback);
      }
    },

    removeAllListeners: (channel: string) => {
      if (channel.startsWith('mcp:')) {
        ipcRenderer.removeAllListeners(channel);
      }
    },
  },

  // Native notifications
  notification: {
    isSupported: (): Promise<boolean> => ipcRenderer.invoke('notification:isSupported'),

    show: (options: {
      title: string;
      body: string;
      silent?: boolean;
      urgency?: 'normal' | 'critical' | 'low';
    }): Promise<{ success: boolean }> => ipcRenderer.invoke('notification:show', options),

    requestComplete: (data: {
      status: number;
      time: number;
      url: string;
    }): Promise<{ success: boolean }> => ipcRenderer.invoke('notification:requestComplete', data),

    updateAvailable: (version: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('notification:updateAvailable', version),

    error: (message: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('notification:error', message),
  },

  // Encrypted store operations
  store: {
    get: (key: string): Promise<string | undefined> =>
      ipcRenderer.invoke('store:get', key),

    set: (key: string, value: string): Promise<void> =>
      ipcRenderer.invoke('store:set', key, value),

    delete: (key: string): Promise<void> =>
      ipcRenderer.invoke('store:delete', key),

    clear: (): Promise<void> =>
      ipcRenderer.invoke('store:clear'),

    has: (key: string): Promise<boolean> =>
      ipcRenderer.invoke('store:has', key),
  },

  // Request log operations
  log: {
    getHistory: (limit?: number): Promise<unknown[]> => ipcRenderer.invoke('log:getHistory', limit),
    clear: (): Promise<void> => ipcRenderer.invoke('log:clear'),
  },

  // Collection file operations (Git-native collections)
  collections: {
    loadFromDirectory: (directoryPath: string): Promise<{
      success: boolean;
      collection?: unknown;
      error?: string;
    }> => ipcRenderer.invoke('collection:load-directory', directoryPath),

    saveToDirectory: (collection: unknown, directoryPath: string): Promise<{
      success: boolean;
      error?: string;
    }> => ipcRenderer.invoke('collection:save-directory', collection, directoryPath),

    watchDirectory: (directoryPath: string): Promise<{
      success: boolean;
      error?: string;
    }> => ipcRenderer.invoke('collection:watch', directoryPath),

    unwatchDirectory: (directoryPath: string): Promise<{
      success: boolean;
    }> => ipcRenderer.invoke('collection:unwatch', directoryPath),

    selectDirectory: (): Promise<{
      canceled: boolean;
      filePaths?: string[];
    }> => ipcRenderer.invoke('collection:select-directory'),

    openInExplorer: (directoryPath: string): Promise<{
      success: boolean;
      error?: string;
    }> => ipcRenderer.invoke('collection:open-in-explorer', directoryPath),

    getFileInfo: (filePath: string): Promise<{
      exists: boolean;
      lastModified?: number;
      size?: number;
    }> => ipcRenderer.invoke('collection:get-file-info', filePath),

    onFileChanged: (callback: (event: {
      type: 'modified' | 'added' | 'deleted';
      filePath: string;
      directoryPath: string;
      lastModified?: number;
    }) => void) => {
      ipcRenderer.on('collection:file-changed', (_event, data) => callback(data));
    },

    removeFileChangedListener: () => {
      ipcRenderer.removeAllListeners('collection:file-changed');
    },
  },

  // Events
  on: (channel: string, callback: (...args: unknown[]) => void) => {
    if (VALID_EVENT_CHANNELS.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => callback(...args));
    }
  },

  removeListener: (channel: string, callback: (...args: unknown[]) => void) => {
    if (VALID_EVENT_CHANNELS.includes(channel)) {
      ipcRenderer.removeListener(channel, callback);
    }
  },
};

// Expose the API to the renderer process
contextBridge.exposeInMainWorld('electron', electronAPI);

// Type definitions for the exposed API
export type ElectronAPI = typeof electronAPI;
