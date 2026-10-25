// IPC channels: App shell: deep links, updater, dialogs, fs, shell, windows, notifications, logs, bug reports, telemetry.
// Composed into IPC / EVENT / EVENT_PREFIX by ../channels.ts.

export const APP_IPC = {
  deepLink: {
    ready: 'deep-link:ready',
    acknowledge: 'deep-link:acknowledge',
    fetchImport: 'deep-link:fetch-import',
  },
  app: {
    checkForUpdates: 'app:checkForUpdates',
    getPath: 'app:getPath',
    getVersion: 'app:getVersion',
  },
  updater: {
    check: 'updater:check',
    status: 'updater:getStatus',
    download: 'updater:download',
    cancel: 'updater:cancel',
    restart: 'updater:restart',
    setConfig: 'updater:setConfig',
  },
  dialog: {
    openFile: 'dialog:openFile',
    saveFile: 'dialog:saveFile',
  },
  fs: {
    readFile: 'fs:readFile',
    writeFile: 'fs:writeFile',
  },
  shell: {
    openExternal: 'shell:openExternal',
  },
  window: {
    minimize: 'window:minimize',
    maximize: 'window:maximize',
    close: 'window:close',
    new: 'window:new',
  },
  notification: {
    isSupported: 'notification:isSupported',
    show: 'notification:show',
    requestComplete: 'notification:requestComplete',
    updateAvailable: 'notification:updateAvailable',
    error: 'notification:error',
  },
  log: {
    getHistory: 'log:getHistory',
    clear: 'log:clear',
  },
  bugReport: {
    captureScreenshot: 'bug-report:captureScreenshot',
    getDiagnostics: 'bug-report:getDiagnostics',
    copyScreenshot: 'bug-report:copyScreenshot',
  },
  telemetry: {
    setConsent: 'telemetry:setConsent',
  },
} as const;

export const APP_EVENT = {
  updaterStatus: 'updater:status',
  deepLink: 'deep-link:received',
} as const;
