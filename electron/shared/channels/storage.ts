// IPC channels: Persistence: electron-store, filesystem collections, OWS workspaces.
// Composed into IPC / EVENT / EVENT_PREFIX by ../channels.ts.

export const STORAGE_IPC = {
  store: {
    get: 'store:get',
    set: 'store:set',
    delete: 'store:delete',
    clear: 'store:clear',
    has: 'store:has',
  },
  collection: {
    loadDirectory: 'collection:load-directory',
    saveDirectory: 'collection:save-directory',
    watch: 'collection:watch',
    unwatch: 'collection:unwatch',
    selectDirectory: 'collection:select-directory',
    openInExplorer: 'collection:open-in-explorer',
    getFileInfo: 'collection:get-file-info',
    saveBrunoDirectory: 'collection:save-bruno-directory',
  },
  owsWorkspace: {
    list: 'ows-workspace:list',
    load: 'ows-workspace:load',
    save: 'ows-workspace:save',
    delete: 'ows-workspace:delete',
  },
} as const;

export const STORAGE_EVENT = {
  collectionFileChanged: 'collection:file-changed',
} as const;
