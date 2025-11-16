/**
 * Platform detection and Electron API utilities
 * This module provides utilities to detect the current platform and access Electron APIs safely
 */

import type { ElectronAPI } from '../../electron/types/electron.d';

/**
 * Check if the application is running in Electron
 */
export function isElectron(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return window.electron?.isElectron === true;
}

/**
 * Check if the application is running in a web browser
 */
export function isWeb(): boolean {
  return !isElectron();
}

/**
 * Get the Electron API if available
 * @returns ElectronAPI or null if not in Electron
 */
export function getElectronAPI(): ElectronAPI | null {
  if (typeof window === 'undefined') {
    return null;
  }
  return window.electron ?? null;
}

/**
 * Get the current platform
 */
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

/**
 * Check if running on macOS
 */
export function isMac(): boolean {
  return getPlatform() === 'darwin';
}

/**
 * Check if running on Windows
 */
export function isWindows(): boolean {
  return getPlatform() === 'win32';
}

/**
 * Check if running on Linux
 */
export function isLinux(): boolean {
  return getPlatform() === 'linux';
}

/**
 * Safe wrapper for Electron file dialog operations
 */
export async function openFileDialog(options?: {
  title?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}): Promise<{ canceled: boolean; filePaths: string[] }> {
  const api = getElectronAPI();
  if (!api) {
    // Fallback for web: use file input
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

/**
 * Safe wrapper for Electron save file dialog
 */
export async function saveFileDialog(options?: {
  title?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}): Promise<{ canceled: boolean; filePath?: string }> {
  const api = getElectronAPI();
  if (!api) {
    // Fallback for web: use download
    return { canceled: false, filePath: options?.defaultPath || 'download' };
  }
  return api.dialog.saveFile(options);
}

/**
 * Read file from disk (Electron only)
 */
export async function readFileFromDisk(
  filePath: string
): Promise<{ success: boolean; content?: string; error?: string }> {
  const api = getElectronAPI();
  if (!api) {
    return { success: false, error: 'File system access not available in web browser' };
  }
  return api.fs.readFile(filePath);
}

/**
 * Write file to disk (Electron only)
 */
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

/**
 * Get application version (Electron only)
 */
export async function getAppVersion(): Promise<string> {
  const api = getElectronAPI();
  if (!api) {
    return process.env.NEXT_PUBLIC_APP_VERSION || '0.1.0';
  }
  return api.app.getVersion();
}

/**
 * Open external URL in default browser
 */
export async function openExternalUrl(url: string): Promise<void> {
  const api = getElectronAPI();
  if (api) {
    await api.shell.openExternal(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

/**
 * Subscribe to Electron menu events
 */
export function onMenuEvent(event: string, callback: (...args: unknown[]) => void): () => void {
  const api = getElectronAPI();
  if (!api) {
    return () => {};
  }
  api.on(event, callback);
  return () => api.removeListener(event, callback);
}
