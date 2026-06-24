/**
 * File Collection Store
 *
 * Manages Git-native collections stored as YAML files on disk.
 * Works alongside useCollectionStore to sync changes to the file system.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ElectronAPI } from '../../electron/types/electron-api';
import { useCollectionStore } from './useCollectionStore';
import { dexieStorageAdapters } from '@/lib/shared/dexie-storage';
import { migrateLegacyLocalStorage } from '@/lib/shared/migrate-legacy-storage';
import { isElectron } from '@/lib/shared/platform';
import type { Collection } from '@/types';

// Runtime UI sync state (distinct from the persisted file `SyncState` in
// file-collection-schema.ts, which tracks git file states like 'new'/'deleted').
export type FileSyncUiState = 'synced' | 'modified' | 'conflict' | 'loading' | 'error';

// Conflict information
export interface ConflictState {
  collectionId: string;
  itemId?: string;
  itemName: string;
  filePath: string;
  localModified: number;
  externalModified: number;
  message?: string;
}

// File collection metadata
export interface FileCollectionInfo {
  collectionId: string;
  directoryPath: string;
  syncState: FileSyncUiState;
  lastSynced: number;
  isWatching: boolean;
  error?: string;
}

interface FileCollectionState {
  // Map of collection ID to file info
  fileCollections: Record<string, FileCollectionInfo>;

  // Active conflicts that need resolution
  conflicts: ConflictState[];

  // Default directory for new file collections
  defaultDirectory: string | null;

  // Actions
  registerFileCollection: (collectionId: string, directoryPath: string) => void;
  unregisterFileCollection: (collectionId: string) => void;
  updateSyncState: (collectionId: string, state: FileSyncUiState, error?: string) => void;
  markAsSynced: (collectionId: string) => void;
  setWatching: (collectionId: string, isWatching: boolean) => void;
  addConflict: (conflict: ConflictState) => void;
  removeConflict: (collectionId: string, itemId?: string) => void;
  clearConflicts: (collectionId: string) => void;
  setDefaultDirectory: (directory: string | null) => void;
  isFileCollection: (collectionId: string) => boolean;
  getFileInfo: (collectionId: string) => FileCollectionInfo | undefined;
}

export const useFileCollectionStore = create<FileCollectionState>()(
  persist(
    (set, get) => ({
      fileCollections: {},
      conflicts: [],
      defaultDirectory: null,

      registerFileCollection: (collectionId, directoryPath) =>
        set((state) => ({
          fileCollections: {
            ...state.fileCollections,
            [collectionId]: {
              collectionId,
              directoryPath,
              syncState: 'synced',
              lastSynced: Date.now(),
              isWatching: false,
            },
          },
        })),

      unregisterFileCollection: (collectionId) =>
        set((state) => {
          const { [collectionId]: _, ...rest } = state.fileCollections;
          return {
            fileCollections: rest,
            conflicts: state.conflicts.filter((c) => c.collectionId !== collectionId),
          };
        }),

      updateSyncState: (collectionId, syncState, error) =>
        set((state) => {
          const existing = state.fileCollections[collectionId];
          if (!existing) return state;
          return {
            fileCollections: {
              ...state.fileCollections,
              [collectionId]: {
                ...existing,
                syncState,
                error,
              },
            },
          };
        }),

      markAsSynced: (collectionId) =>
        set((state) => {
          const existing = state.fileCollections[collectionId];
          if (!existing) return state;
          return {
            fileCollections: {
              ...state.fileCollections,
              [collectionId]: {
                ...existing,
                syncState: 'synced',
                lastSynced: Date.now(),
                error: undefined,
              },
            },
          };
        }),

      setWatching: (collectionId, isWatching) =>
        set((state) => {
          const existing = state.fileCollections[collectionId];
          if (!existing) return state;
          return {
            fileCollections: {
              ...state.fileCollections,
              [collectionId]: {
                ...existing,
                isWatching,
              },
            },
          };
        }),

      addConflict: (conflict) =>
        set((state) => ({
          conflicts: [
            ...state.conflicts.filter(
              (c) => !(c.collectionId === conflict.collectionId && c.itemId === conflict.itemId)
            ),
            conflict,
          ],
        })),

      removeConflict: (collectionId, itemId) =>
        set((state) => ({
          conflicts: state.conflicts.filter(
            (c) =>
              !(c.collectionId === collectionId && (itemId === undefined || c.itemId === itemId))
          ),
        })),

      clearConflicts: (collectionId) =>
        set((state) => ({
          conflicts: state.conflicts.filter((c) => c.collectionId !== collectionId),
        })),

      setDefaultDirectory: (directory) => set({ defaultDirectory: directory }),

      isFileCollection: (collectionId) => collectionId in get().fileCollections,

      getFileInfo: (collectionId) => get().fileCollections[collectionId],
    }),
    {
      name: 'file-collection-storage',
      version: 1,
      storage: dexieStorageAdapters.fileCollections(),
      partialize: (state) => ({
        fileCollections: state.fileCollections,
        defaultDirectory: state.defaultDirectory,
      }),
      migrate: (persistedState, _version) => {
        // If Dexie returned no/empty data, attempt a one-shot backfill
        // from the legacy zustand/persist localStorage key. The helper
        // also removes the legacy key so we never migrate twice.
        const looksEmpty =
          !persistedState ||
          (typeof persistedState === 'object' &&
            Object.keys(persistedState as object).length === 0);
        if (looksEmpty) {
          const legacy =
            migrateLegacyLocalStorage<Partial<FileCollectionState>>('file-collection-storage');
          if (legacy) return legacy as FileCollectionState;
        }
        return persistedState as FileCollectionState;
      },
      onRehydrateStorage: () => (_state, error) => {
        if (error) {
          console.error('File-collection store rehydration failed:', error);
        }
      },
    }
  )
);

function getElectronCollections(): ElectronAPI['collections'] | null {
  if (typeof window !== 'undefined' && window.electron?.collections) {
    return window.electron.collections;
  }
  return null;
}

export { isElectron as isElectronEnvironment };

/**
 * Register a main-process file watcher for a collection directory and reflect
 * the result in the store. The active-watcher set IS the git allowlist (see
 * `restoreFileCollectionWatchers`), so `isWatching` tracks whether the watch
 * actually took. Rejects only if the IPC invoke itself fails.
 */
async function startWatching(collectionId: string, directoryPath: string): Promise<void> {
  const electron = getElectronCollections();
  if (!electron) return;
  const res = await electron.watchDirectory(directoryPath);
  useFileCollectionStore.getState().setWatching(collectionId, res?.success !== false);
}

// Load collection from directory
export async function loadCollectionFromDirectory(directoryPath: string): Promise<{
  success: boolean;
  collection?: Collection;
  error?: string;
}> {
  const electron = getElectronCollections();
  if (!electron) {
    return { success: false, error: 'File collections only available in Electron' };
  }

  const result = await electron.loadFromDirectory(directoryPath);
  if (result.success && result.collection) {
    const collection = result.collection as Collection;

    // The main process mints a fresh collection id on every load, so the upsert
    // below can't match an already-open collection by id alone — it would always
    // take the `addCollection` branch. A file collection's identity is its
    // directory, so reuse the id already registered for this directory (if any).
    // Without this, every reload (ConflictDialog "Load external", post-checkout
    // reload) duplicates the collection in the sidebar and orphans the prior
    // fileCollections entry.
    const fileStore = useFileCollectionStore.getState();
    const existing = Object.values(fileStore.fileCollections).find(
      (info) => info.directoryPath === directoryPath
    );
    if (existing) collection.id = existing.collectionId;

    // Upsert into the collection store. This is also the reload primitive
    // (ConflictDialog "Load external", post-checkout reload), so it MUST replace
    // an existing collection rather than append — `addCollection` appends, which
    // would duplicate the collection in the sidebar on every reload.
    const collectionStore = useCollectionStore.getState();
    if (collectionStore.getCollectionById(collection.id)) {
      collectionStore.updateCollection(collection.id, collection);
    } else {
      collectionStore.addCollection(collection);
    }

    // Register as file collection
    fileStore.registerFileCollection(collection.id, directoryPath);

    // Start watching (the active-watcher set is the git allowlist).
    await startWatching(collection.id, directoryPath);

    return { success: true, collection };
  }

  return result as { success: boolean; error?: string };
}

// Save collection to directory
export async function saveCollectionToDirectory(
  collection: Collection,
  directoryPath: string
): Promise<{ success: boolean; error?: string }> {
  const electron = getElectronCollections();
  if (!electron) {
    return { success: false, error: 'File collections only available in Electron' };
  }

  const fileStore = useFileCollectionStore.getState();
  fileStore.updateSyncState(collection.id, 'loading');

  const result = await electron.saveToDirectory(collection, directoryPath);
  if (result.success) {
    fileStore.markAsSynced(collection.id);
  } else {
    fileStore.updateSyncState(collection.id, 'error', result.error);
  }

  return result;
}

// Sync a file collection (save current state to disk)
export async function syncFileCollection(collectionId: string): Promise<{
  success: boolean;
  error?: string;
}> {
  const fileStore = useFileCollectionStore.getState();
  const fileInfo = fileStore.getFileInfo(collectionId);
  if (!fileInfo) {
    return { success: false, error: 'Not a file collection' };
  }

  const collectionStore = useCollectionStore.getState();
  const collection = collectionStore.getCollectionById(collectionId);
  if (!collection) {
    return { success: false, error: 'Collection not found' };
  }

  return saveCollectionToDirectory(collection, fileInfo.directoryPath);
}

// Open collection directory in file explorer
export async function openCollectionInExplorer(collectionId: string): Promise<void> {
  const electron = getElectronCollections();
  const fileStore = useFileCollectionStore.getState();
  const fileInfo = fileStore.getFileInfo(collectionId);

  if (electron && fileInfo) {
    await electron.openInExplorer(fileInfo.directoryPath);
  }
}

// Select a directory for a new file collection
export async function selectCollectionDirectory(): Promise<string | null> {
  const electron = getElectronCollections();
  if (!electron) return null;

  const result = await electron.selectDirectory();
  if (!result.canceled && result.filePaths?.[0]) {
    return result.filePaths[0];
  }
  return null;
}

// Export collection to file directory (migrate from localStorage)
export async function exportCollectionToFiles(
  collectionId: string,
  directoryPath: string
): Promise<{ success: boolean; error?: string }> {
  const collectionStore = useCollectionStore.getState();
  const collection = collectionStore.getCollectionById(collectionId);
  if (!collection) {
    return { success: false, error: 'Collection not found' };
  }

  const result = await saveCollectionToDirectory(collection, directoryPath);
  if (result.success) {
    // Register as file collection
    useFileCollectionStore.getState().registerFileCollection(collectionId, directoryPath);

    // Start watching (the active-watcher set is the git allowlist).
    await startWatching(collectionId, directoryPath);
  }

  return result;
}

/**
 * Re-register a chokidar watcher for every persisted file collection.
 *
 * The git allowlist in the main process IS the set of active watchers, and that
 * set lives only in memory — it is wiped on every app restart while the
 * collections themselves persist. Without this, after a restart every git
 * operation on a previously-opened collection fails with "Directory not allowed"
 * until the user manually re-opens the folder. Call once at startup, after the
 * store has hydrated. Idempotent: `watchDirectory` replaces any existing watcher.
 */
export async function restoreFileCollectionWatchers(): Promise<void> {
  const { fileCollections, setWatching } = useFileCollectionStore.getState();
  await Promise.all(
    Object.values(fileCollections).map((info) =>
      // A directory deleted/unmounted since last session rejects — leave
      // isWatching false so the UI reflects that it isn't git-eligible.
      startWatching(info.collectionId, info.directoryPath).catch(() =>
        setWatching(info.collectionId, false)
      )
    )
  );
}

// Initialize file watcher event handler
export function initFileCollectionWatcher(): void {
  const electron = getElectronCollections();
  if (!electron) return;

  electron.onFileChanged((event) => {
    const fileStore = useFileCollectionStore.getState();

    // Find which collection this file belongs to
    const fileInfo = Object.values(fileStore.fileCollections).find(
      (info) =>
        event.directoryPath === info.directoryPath || event.filePath.startsWith(info.directoryPath)
    );

    if (!fileInfo) return;

    if (event.type === 'modified') {
      // File was modified externally - potential conflict
      fileStore.addConflict({
        collectionId: fileInfo.collectionId,
        itemName: event.filePath.split('/').pop() || 'Unknown',
        filePath: event.filePath,
        localModified: fileInfo.lastSynced,
        externalModified: event.lastModified || Date.now(),
        message: 'File was modified externally',
      });
      fileStore.updateSyncState(fileInfo.collectionId, 'conflict');
    } else if (event.type === 'added' || event.type === 'deleted') {
      // File was added or deleted - need to reload
      fileStore.updateSyncState(fileInfo.collectionId, 'modified');
    }
  });
}

// Cleanup file watcher
export function cleanupFileCollectionWatcher(): void {
  const electron = getElectronCollections();
  if (electron) {
    electron.removeFileChangedListener();
  }
}
