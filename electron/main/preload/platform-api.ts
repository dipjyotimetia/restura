import { ipcRenderer } from 'electron';
import { EVENT, IPC, VALID_EVENT_CHANNELS } from '../../shared/channels';
import type { ElectronAPI, UpdaterStatus } from '../../types/electron-api';
import { addWrappedListener, removeWrappedListener } from '../handlers/channel-event-bridge';
import { invoke, send } from './invoke';

type PlatformApi = Pick<
  ElectronAPI,
  | 'platform'
  | 'isElectron'
  | 'dialog'
  | 'fs'
  | 'app'
  | 'updater'
  | 'shell'
  | 'window'
  | 'notification'
  | 'store'
  | 'log'
  | 'keychain'
  | 'telemetry'
  | 'security'
  | 'bugReport'
  | 'on'
  | 'removeListener'
>;

const validEventChannels: readonly string[] = VALID_EVENT_CHANNELS;

export const platformApi: PlatformApi = {
  platform: process.platform,
  isElectron: true,
  dialog: {
    openFile: invoke<ElectronAPI['dialog']['openFile']>(IPC.dialog.openFile),
    saveFile: invoke<ElectronAPI['dialog']['saveFile']>(IPC.dialog.saveFile),
  },
  fs: {
    readFile: invoke<ElectronAPI['fs']['readFile']>(IPC.fs.readFile),
    writeFile: invoke<ElectronAPI['fs']['writeFile']>(IPC.fs.writeFile),
  },
  app: {
    getPath: invoke<ElectronAPI['app']['getPath']>(IPC.app.getPath),
    getVersion: invoke<ElectronAPI['app']['getVersion']>(IPC.app.getVersion),
    checkForUpdates: invoke<ElectronAPI['app']['checkForUpdates']>(IPC.app.checkForUpdates),
  },
  updater: {
    check: invoke<ElectronAPI['updater']['check']>(IPC.updater.check),
    getStatus: invoke<ElectronAPI['updater']['getStatus']>(IPC.updater.status),
    download: invoke<ElectronAPI['updater']['download']>(IPC.updater.download),
    cancel: invoke<ElectronAPI['updater']['cancel']>(IPC.updater.cancel),
    restart: invoke<ElectronAPI['updater']['restart']>(IPC.updater.restart),
    setConfig: invoke<ElectronAPI['updater']['setConfig']>(IPC.updater.setConfig),
    onStatus: (callback: (status: UpdaterStatus) => void): (() => void) => {
      const listener = (_event: unknown, status: UpdaterStatus) => callback(status);
      ipcRenderer.on(EVENT.updaterStatus, listener as Parameters<typeof ipcRenderer.on>[1]);
      return () =>
        ipcRenderer.removeListener(
          EVENT.updaterStatus,
          listener as Parameters<typeof ipcRenderer.on>[1]
        );
    },
  },
  shell: {
    openExternal: invoke<ElectronAPI['shell']['openExternal']>(IPC.shell.openExternal),
  },
  window: {
    minimize: send<ElectronAPI['window']['minimize']>(IPC.window.minimize),
    maximize: send<ElectronAPI['window']['maximize']>(IPC.window.maximize),
    close: send<ElectronAPI['window']['close']>(IPC.window.close),
    openNew: invoke<ElectronAPI['window']['openNew']>(IPC.window.new),
  },
  notification: {
    isSupported: invoke<ElectronAPI['notification']['isSupported']>(IPC.notification.isSupported),
    show: invoke<ElectronAPI['notification']['show']>(IPC.notification.show),
    requestComplete: invoke<ElectronAPI['notification']['requestComplete']>(
      IPC.notification.requestComplete
    ),
    updateAvailable: invoke<ElectronAPI['notification']['updateAvailable']>(
      IPC.notification.updateAvailable
    ),
    error: invoke<ElectronAPI['notification']['error']>(IPC.notification.error),
  },
  store: {
    get: invoke<ElectronAPI['store']['get']>(IPC.store.get),
    set: invoke<ElectronAPI['store']['set']>(IPC.store.set),
    delete: invoke<ElectronAPI['store']['delete']>(IPC.store.delete),
    clear: invoke<ElectronAPI['store']['clear']>(IPC.store.clear),
    has: invoke<ElectronAPI['store']['has']>(IPC.store.has),
  },
  log: {
    getHistory: invoke<ElectronAPI['log']['getHistory']>(IPC.log.getHistory),
    clear: invoke<ElectronAPI['log']['clear']>(IPC.log.clear),
  },
  keychain: {
    status: invoke<ElectronAPI['keychain']['status']>(IPC.keychain.status),
    rotate: invoke<ElectronAPI['keychain']['rotate']>(IPC.keychain.rotate),
  },
  telemetry: {
    setConsent: invoke<ElectronAPI['telemetry']['setConsent']>(IPC.telemetry.setConsent),
  },
  security: {
    setExecutionPolicy: invoke<ElectronAPI['security']['setExecutionPolicy']>(
      IPC.security.setExecutionPolicy
    ),
  },
  bugReport: {
    getDiagnostics: invoke<ElectronAPI['bugReport']['getDiagnostics']>(
      IPC.bugReport.getDiagnostics
    ),
    captureScreenshot: invoke<ElectronAPI['bugReport']['captureScreenshot']>(
      IPC.bugReport.captureScreenshot
    ),
    copyScreenshot: invoke<ElectronAPI['bugReport']['copyScreenshot']>(
      IPC.bugReport.copyScreenshot
    ),
  },
  on: (channel: string, callback: (...args: unknown[]) => void): void => {
    if (validEventChannels.includes(channel)) addWrappedListener(channel, callback);
  },
  removeListener: (channel: string, callback: (...args: unknown[]) => void): void => {
    if (validEventChannels.includes(channel)) removeWrappedListener(channel, callback);
  },
};
