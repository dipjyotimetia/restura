/**
 * Electron integration utilities
 *
 * This module provides:
 * - Type-safe IPC utilities
 * - React hooks for Electron features
 * - Platform detection helpers
 */

// IPC utilities
export {
  isElectron,
  getElectronAPI,
  ipcInvoke,
  ipcSend,
  ipcOn,
  openFileDialog,
  saveFileDialog,
  readFile,
  writeFile,
  openExternal,
  getAppVersion,
  type IPCInvokeChannels,
  type IPCEventChannels,
  type IPCSendChannels,
} from './ipc';

// React hooks
export {
  useIsElectron,
  useIPCEvent,
  useIPCInvoke,
  useFileDialog,
  useFileRead,
  useFileWrite,
  useAppVersion,
  useOpenExternal,
  useWindowControls,
  useAutoUpdate,
  useNotification,
  useElectronHttp,
} from './hooks';
