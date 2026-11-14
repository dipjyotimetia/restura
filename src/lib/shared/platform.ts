/**
 * Base URL for the Cloudflare Worker API.
 * In production the SPA lives on restura.dev and the Worker on api.restura.dev
 * (set via VITE_WORKER_URL at build time), so we need an absolute origin. In
 * dev both run together via Miniflare so the origin is empty.
 */
export function workerBaseUrl(): string {
  return import.meta.env.VITE_WORKER_URL ?? '';
}

/**
 * Optional auth header for deployments that protect the Worker proxy.
 * Public hosted builds should prefer Cloudflare Access over embedding a token.
 */
export function workerAuthHeaders(): Record<string, string> {
  const token = import.meta.env.VITE_WORKER_PROXY_TOKEN;
  return token ? { 'X-Restura-Proxy-Token': token } : {};
}

import type { ElectronAPI } from '../../../electron/types/electron-api';

export function isElectron(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return window.electron?.isElectron === true;
}

export function isWeb(): boolean {
  return !isElectron();
}

export function getElectronAPI(): ElectronAPI | null {
  if (typeof window === 'undefined') {
    return null;
  }
  return window.electron ?? null;
}

export function getPlatform(): 'darwin' | 'win32' | 'linux' | 'web' {
  if (!isElectron()) {
    return 'web';
  }
  const api = getElectronAPI();
  if (api?.platform) {
    return api.platform as 'darwin' | 'win32' | 'linux';
  }
  return 'web';
}

export function isMac(): boolean {
  return getPlatform() === 'darwin';
}

export function isWindows(): boolean {
  return getPlatform() === 'win32';
}

export function isLinux(): boolean {
  return getPlatform() === 'linux';
}

export async function openFileDialog(options?: {
  title?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}): Promise<{ canceled: boolean; filePaths: string[] }> {
  const api = getElectronAPI();
  if (!api) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      if (options?.filters) {
        const extensions = options.filters.flatMap((f) => f.extensions.map((ext) => `.${ext}`));
        input.accept = extensions.join(',');
      }
      input.onchange = () => {
        const files = input.files;
        if (files && files.length > 0) {
          resolve({ canceled: false, filePaths: [files[0]?.name ?? ''] });
        } else {
          resolve({ canceled: true, filePaths: [] });
        }
      };
      input.click();
    });
  }
  return api.dialog.openFile(options);
}

export async function saveFileDialog(options?: {
  title?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}): Promise<{ canceled: boolean; filePath?: string }> {
  const api = getElectronAPI();
  if (!api) {
    return { canceled: false, filePath: options?.defaultPath || 'download' };
  }
  return api.dialog.saveFile(options);
}

export async function readFileFromDisk(
  filePath: string
): Promise<{ success: boolean; content?: string; error?: string }> {
  const api = getElectronAPI();
  if (!api) {
    return { success: false, error: 'File system access not available in web browser' };
  }
  return api.fs.readFile(filePath);
}

export async function writeFileToDisk(
  filePath: string,
  content: string
): Promise<{ success: boolean; error?: string }> {
  const api = getElectronAPI();
  if (!api) {
    return { success: false, error: 'File system access not available in web browser' };
  }
  return api.fs.writeFile(filePath, content);
}

export async function getAppVersion(): Promise<string> {
  const api = getElectronAPI();
  if (!api) {
    return import.meta.env.VITE_APP_VERSION || '0.1.0';
  }
  return api.app.getVersion();
}

export async function openExternalUrl(url: string): Promise<void> {
  const api = getElectronAPI();
  if (api) {
    await api.shell.openExternal(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

export function onMenuEvent(event: string, callback: (...args: unknown[]) => void): () => void {
  const api = getElectronAPI();
  if (!api) {
    return () => {};
  }
  api.on(event, callback);
  return () => api.removeListener(event, callback);
}
