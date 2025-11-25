/**
 * React hooks for Electron IPC communication
 *
 * Provides type-safe, React-friendly wrappers around the Electron IPC API
 * with proper lifecycle management and error handling.
 */

import { useCallback, useEffect, useState, useRef, useSyncExternalStore } from 'react';
import {
  isElectron,
  ipcInvoke,
  ipcOn,
  openFileDialog,
  saveFileDialog,
  readFile,
  writeFile,
  openExternal,
  getAppVersion,
  type IPCInvokeChannels,
  type IPCEventChannels,
} from './ipc';

// ============================================================================
// Platform Detection Hook
// ============================================================================

/**
 * Hook to check if running in Electron environment
 * Uses useSyncExternalStore for SSR safety
 */
export function useIsElectron(): boolean {
  const getSnapshot = useCallback(() => isElectron(), []);
  const getServerSnapshot = useCallback(() => false, []);

  return useSyncExternalStore(() => () => {}, getSnapshot, getServerSnapshot);
}

// ============================================================================
// IPC Event Subscription Hook
// ============================================================================

/**
 * Subscribe to IPC events from the main process
 * Automatically cleans up listener on unmount
 */
export function useIPCEvent<K extends keyof IPCEventChannels>(
  channel: K,
  callback: (data: IPCEventChannels[K]) => void,
  enabled = true
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!enabled || !isElectron()) return;

    const cleanup = ipcOn(channel, (data) => {
      callbackRef.current(data);
    });

    return cleanup;
  }, [channel, enabled]);
}

// ============================================================================
// IPC Invoke Hooks
// ============================================================================

interface UseIPCInvokeResult<T> {
  data: T | null;
  error: Error | null;
  isLoading: boolean;
  invoke: () => Promise<T | null>;
  reset: () => void;
}

/**
 * Hook for IPC invoke calls with loading/error state
 */
export function useIPCInvoke<K extends keyof IPCInvokeChannels>(
  channel: K,
  params: IPCInvokeChannels[K]['params'],
  options?: { immediate?: boolean }
): UseIPCInvokeResult<IPCInvokeChannels[K]['result']> {
  type Result = IPCInvokeChannels[K]['result'];

  const [data, setData] = useState<Result | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const invoke = useCallback(async (): Promise<Result | null> => {
    if (!isElectron()) {
      setError(new Error('IPC not available'));
      return null;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = await ipcInvoke(channel, params);
      setData(result);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setError(error);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [channel, params]);

  const reset = useCallback(() => {
    setData(null);
    setError(null);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    if (options?.immediate) {
      invoke();
    }
  }, [options?.immediate, invoke]);

  return { data, error, isLoading, invoke, reset };
}

// ============================================================================
// File Dialog Hooks
// ============================================================================

interface FileDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

interface OpenFileDialogOptions extends FileDialogOptions {
  properties?: Array<'openFile' | 'openDirectory' | 'multiSelections'>;
}

/**
 * Hook for opening file dialogs
 */
export function useFileDialog() {
  const [isOpen, setIsOpen] = useState(false);

  const openFile = useCallback(async (options?: OpenFileDialogOptions) => {
    setIsOpen(true);
    try {
      return await openFileDialog(options);
    } finally {
      setIsOpen(false);
    }
  }, []);

  const saveFile = useCallback(async (options?: FileDialogOptions) => {
    setIsOpen(true);
    try {
      return await saveFileDialog(options);
    } finally {
      setIsOpen(false);
    }
  }, []);

  return { openFile, saveFile, isOpen };
}

// ============================================================================
// File System Hooks
// ============================================================================

interface FileReadResult {
  content: string | null;
  error: string | null;
  isLoading: boolean;
  read: (path: string) => Promise<string | null>;
}

/**
 * Hook for reading files
 */
export function useFileRead(): FileReadResult {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const read = useCallback(async (path: string): Promise<string | null> => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await readFile(path);
      if (result.success && result.content) {
        setContent(result.content);
        return result.content;
      } else {
        setError(result.error || 'Failed to read file');
        return null;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { content, error, isLoading, read };
}

interface FileWriteResult {
  error: string | null;
  isLoading: boolean;
  write: (path: string, content: string) => Promise<boolean>;
}

/**
 * Hook for writing files
 */
export function useFileWrite(): FileWriteResult {
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const write = useCallback(async (path: string, content: string): Promise<boolean> => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await writeFile(path, content);
      if (!result.success) {
        setError(result.error || 'Failed to write file');
        return false;
      }
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
      return false;
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { error, isLoading, write };
}

// ============================================================================
// App Info Hooks
// ============================================================================

/**
 * Hook to get the app version
 */
export function useAppVersion(): string {
  const [version, setVersion] = useState<string>('');

  useEffect(() => {
    getAppVersion().then(setVersion);
  }, []);

  return version;
}

// ============================================================================
// External Links Hook
// ============================================================================

/**
 * Hook to open external URLs
 */
export function useOpenExternal() {
  const open = useCallback(async (url: string) => {
    await openExternal(url);
  }, []);

  return open;
}

// ============================================================================
// Window Controls Hook
// ============================================================================

interface WindowControls {
  minimize: () => void;
  maximize: () => void;
  close: () => void;
}

/**
 * Hook for window controls (minimize, maximize, close)
 */
export function useWindowControls(): WindowControls | null {
  const isElectronEnv = useIsElectron();

  const minimize = useCallback(() => {
    if (typeof window !== 'undefined' && window.electron) {
      window.electron.window.minimize();
    }
  }, []);

  const maximize = useCallback(() => {
    if (typeof window !== 'undefined' && window.electron) {
      window.electron.window.maximize();
    }
  }, []);

  const close = useCallback(() => {
    if (typeof window !== 'undefined' && window.electron) {
      window.electron.window.close();
    }
  }, []);

  if (!isElectronEnv) return null;

  return { minimize, maximize, close };
}

// ============================================================================
// Auto-Update Hooks
// ============================================================================

interface UpdateState {
  checking: boolean;
  available: boolean;
  version: string | null;
  progress: number;
  ready: boolean;
  error: string | null;
}

/**
 * Hook for auto-update status and events
 */
export function useAutoUpdate(): UpdateState & { checkForUpdates: () => Promise<void> } {
  const [state, setState] = useState<UpdateState>({
    checking: false,
    available: false,
    version: null,
    progress: 0,
    ready: false,
    error: null,
  });

  // Subscribe to update events
  useIPCEvent('update:checking', () => {
    setState((prev) => ({ ...prev, checking: true, error: null }));
  });

  useIPCEvent('update:available', ({ version }) => {
    setState((prev) => ({ ...prev, checking: false, available: true, version }));
  });

  useIPCEvent('update:not-available', () => {
    setState((prev) => ({ ...prev, checking: false, available: false }));
  });

  useIPCEvent('update:progress', (progress) => {
    setState((prev) => ({ ...prev, progress }));
  });

  useIPCEvent('update:ready', () => {
    setState((prev) => ({ ...prev, ready: true }));
  });

  useIPCEvent('update:error', (error) => {
    setState((prev) => ({ ...prev, checking: false, error }));
  });

  const checkForUpdates = useCallback(async () => {
    if (!isElectron()) return;

    setState((prev) => ({ ...prev, checking: true, error: null }));
    try {
      await ipcInvoke('app:checkForUpdates', undefined);
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Check failed';
      setState((prev) => ({ ...prev, checking: false, error }));
    }
  }, []);

  return { ...state, checkForUpdates };
}

// ============================================================================
// Notification Hook
// ============================================================================

interface NotificationOptions {
  title: string;
  body: string;
  silent?: boolean;
  urgency?: 'normal' | 'critical' | 'low';
}

/**
 * Hook for showing native notifications
 */
export function useNotification() {
  const [isSupported, setIsSupported] = useState<boolean | null>(null);

  useEffect(() => {
    if (isElectron()) {
      ipcInvoke('notification:isSupported', undefined).then(setIsSupported);
    } else {
      setIsSupported('Notification' in window);
    }
  }, []);

  const show = useCallback(async (options: NotificationOptions): Promise<boolean> => {
    if (!isElectron()) {
      // Web fallback
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(options.title, { body: options.body, silent: options.silent });
        return true;
      }
      return false;
    }

    try {
      const result = await ipcInvoke('notification:show', options);
      return result.success;
    } catch {
      return false;
    }
  }, []);

  return { isSupported, show };
}

// ============================================================================
// HTTP Request Hook (for Electron-native requests)
// ============================================================================

interface HttpRequestOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  data?: string;
  timeout?: number;
}

interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: unknown;
}

/**
 * Hook for making HTTP requests through Electron (bypasses CORS)
 */
export function useElectronHttp() {
  const [response, setResponse] = useState<HttpResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const request = useCallback(async (options: HttpRequestOptions): Promise<HttpResponse | null> => {
    if (!isElectron()) {
      setError(new Error('Electron HTTP not available'));
      return null;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = await ipcInvoke('http:request', options);
      setResponse(result);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setError(error);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { response, error, isLoading, request };
}
