import { contextBridge, ipcRenderer } from 'electron';

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

  // Events
  on: (channel: string, callback: (...args: unknown[]) => void) => {
    const validChannels = ['menu:import', 'menu:export', 'menu:new-request', 'app:focus'];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => callback(...args));
    }
  },

  removeListener: (channel: string, callback: (...args: unknown[]) => void) => {
    ipcRenderer.removeListener(channel, callback);
  },
};

// Expose the API to the renderer process
contextBridge.exposeInMainWorld('electron', electronAPI);

// Type definitions for the exposed API
export type ElectronAPI = typeof electronAPI;
