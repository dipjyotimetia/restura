import type { ChatStreamEvent } from '@shared/protocol/ai/types';
import { ipcRenderer } from 'electron';
import { EVENT, EVENT_PREFIX, eventChannel, IPC } from '../../shared/channels';
import type { ElectronAPI } from '../../types/electron-api';
import { invoke } from './invoke';

type IntegrationApi = Pick<
  ElectronAPI,
  'git' | 'mock' | 'capture' | 'secrets' | 'vault' | 'ai' | 'aiLab' | 'collections' | 'owsWorkspace'
>;

function subscribe<TPayload>(channel: string, callback: (payload: TPayload) => void): () => void {
  const listener = (_event: unknown, payload: TPayload) => callback(payload);
  ipcRenderer.on(channel, listener as Parameters<typeof ipcRenderer.on>[1]);
  return () =>
    ipcRenderer.removeListener(channel, listener as Parameters<typeof ipcRenderer.on>[1]);
}

export const integrationApi: IntegrationApi = {
  git: {
    init: (directoryPath) => ipcRenderer.invoke(IPC.git.init, { directoryPath }),
    status: (directoryPath) => ipcRenderer.invoke(IPC.git.status, { directoryPath }),
    log: (directoryPath, limit) =>
      ipcRenderer.invoke(IPC.git.log, {
        directoryPath,
        ...(limit !== undefined ? { limit } : {}),
      }),
    diff: (directoryPath, filePath) =>
      ipcRenderer.invoke(IPC.git.diff, { directoryPath, filePath }),
    branchList: (directoryPath) => ipcRenderer.invoke(IPC.git.branchList, { directoryPath }),
    add: (directoryPath, filePaths) =>
      ipcRenderer.invoke(IPC.git.add, { directoryPath, filePaths }),
    commit: (directoryPath, message, options) =>
      ipcRenderer.invoke(IPC.git.commit, {
        directoryPath,
        message,
        ...(options?.all !== undefined ? { all: options.all } : {}),
        ...(options?.paths !== undefined ? { paths: options.paths } : {}),
      }),
    createBranch: (directoryPath, name) =>
      ipcRenderer.invoke(IPC.git.createBranch, { directoryPath, name }),
    checkoutBranch: (directoryPath, name) =>
      ipcRenderer.invoke(IPC.git.checkoutBranch, { directoryPath, name }),
  },
  mock: {
    start: invoke<ElectronAPI['mock']['start']>(IPC.mock.start),
    stop: invoke<ElectronAPI['mock']['stop']>(IPC.mock.stop),
    status: invoke<ElectronAPI['mock']['status']>(IPC.mock.status),
  },
  capture: {
    startBridge: invoke<ElectronAPI['capture']['startBridge']>(IPC.captureBridge.start),
    stopBridge: invoke<ElectronAPI['capture']['stopBridge']>(IPC.captureBridge.stop),
    bridgeStatus: invoke<ElectronAPI['capture']['bridgeStatus']>(IPC.captureBridge.status),
    onReceived: (callback) => {
      ipcRenderer.on(EVENT.captureReceived, (_event, document) => callback(document));
    },
    removeReceivedListener: () => ipcRenderer.removeAllListeners(EVENT.captureReceived),
  },
  secrets: {
    store: invoke<ElectronAPI['secrets']['store']>(IPC.secret.store),
    delete: (id) => ipcRenderer.invoke(IPC.secret.delete, { id }),
    describe: (id) => ipcRenderer.invoke(IPC.secret.describe, { id }),
    list: invoke<ElectronAPI['secrets']['list']>(IPC.secret.list),
    clear: invoke<ElectronAPI['secrets']['clear']>(IPC.secret.clear),
  },
  vault: {
    get: (key) => ipcRenderer.invoke(IPC.vault.get, { key }),
    set: (key, value) => ipcRenderer.invoke(IPC.vault.set, { key, value }),
    unset: (key) => ipcRenderer.invoke(IPC.vault.unset, { key }),
    clear: invoke<ElectronAPI['vault']['clear']>(IPC.vault.clear),
  },
  ai: {
    chat: invoke<ElectronAPI['ai']['chat']>(IPC.ai.chat),
    cancel: invoke<ElectronAPI['ai']['cancel']>(IPC.ai.chatCancel),
    onChunk: (streamId, callback) =>
      subscribe<ChatStreamEvent>(eventChannel(EVENT_PREFIX.ai.chunk, streamId), callback),
    onEnd: (streamId, callback) =>
      subscribe<{ reason: 'done' | 'cancelled' | 'error' }>(
        eventChannel(EVENT_PREFIX.ai.end, streamId),
        callback
      ),
  },
  aiLab: {
    exportTelemetry: invoke<ElectronAPI['aiLab']['exportTelemetry']>(IPC.aiLab.exportTelemetry),
    complete: invoke<ElectronAPI['aiLab']['complete']>(IPC.aiLab.complete),
    cancelComplete: invoke<ElectronAPI['aiLab']['cancelComplete']>(IPC.aiLab.completeCancel),
    stream: invoke<ElectronAPI['aiLab']['stream']>(IPC.aiLab.stream),
    cancelStream: invoke<ElectronAPI['aiLab']['cancelStream']>(IPC.aiLab.streamCancel),
    listModels: invoke<ElectronAPI['aiLab']['listModels']>(IPC.aiLab.listModels),
    testConnection: invoke<ElectronAPI['aiLab']['testConnection']>(IPC.aiLab.testConnection),
    onChunk: (streamId, callback) =>
      subscribe<ChatStreamEvent>(eventChannel(EVENT_PREFIX.aiLab.chunk, streamId), callback),
    onEnd: (streamId, callback) =>
      subscribe<{ reason: 'done' | 'cancelled' | 'error' }>(
        eventChannel(EVENT_PREFIX.aiLab.end, streamId),
        callback
      ),
  },
  collections: {
    loadFromDirectory: invoke<ElectronAPI['collections']['loadFromDirectory']>(
      IPC.collection.loadDirectory
    ),
    saveToDirectory: invoke<ElectronAPI['collections']['saveToDirectory']>(
      IPC.collection.saveDirectory
    ),
    saveBrunoToDirectory: invoke<ElectronAPI['collections']['saveBrunoToDirectory']>(
      IPC.collection.saveBrunoDirectory
    ),
    watchDirectory: invoke<ElectronAPI['collections']['watchDirectory']>(IPC.collection.watch),
    unwatchDirectory: invoke<ElectronAPI['collections']['unwatchDirectory']>(
      IPC.collection.unwatch
    ),
    selectDirectory: invoke<ElectronAPI['collections']['selectDirectory']>(
      IPC.collection.selectDirectory
    ),
    openInExplorer: invoke<ElectronAPI['collections']['openInExplorer']>(
      IPC.collection.openInExplorer
    ),
    getFileInfo: invoke<ElectronAPI['collections']['getFileInfo']>(IPC.collection.getFileInfo),
    onFileChanged: (callback) => {
      ipcRenderer.on(EVENT.collectionFileChanged, (_event, data) => callback(data));
    },
    removeFileChangedListener: () => ipcRenderer.removeAllListeners(EVENT.collectionFileChanged),
  },
  owsWorkspace: {
    list: (directoryPath) => ipcRenderer.invoke(IPC.owsWorkspace.list, { directoryPath }),
    load: (directoryPath, workflowId) =>
      ipcRenderer.invoke(IPC.owsWorkspace.load, { directoryPath, workflowId }),
    save: (directoryPath, workflowId, artifact) =>
      ipcRenderer.invoke(IPC.owsWorkspace.save, { directoryPath, workflowId, ...artifact }),
    delete: (directoryPath, workflowId) =>
      ipcRenderer.invoke(IPC.owsWorkspace.delete, { directoryPath, workflowId }),
  },
};
