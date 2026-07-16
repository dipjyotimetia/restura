// Keep this entry at electron/main root: packaging resolves preload.js relative
// to the compiled main process. Feature sections live in ./preload/*.
import '@sentry/electron/preload';
import { contextBridge } from 'electron';
import type { ElectronAPI } from '../types/electron-api';
import { integrationApi } from './preload/integration-api';
import { platformApi } from './preload/platform-api';
import { protocolApi } from './preload/protocol-api';

const electronAPI = {
  ...platformApi,
  ...protocolApi,
  ...integrationApi,
} satisfies ElectronAPI;

contextBridge.exposeInMainWorld('electron', electronAPI);
