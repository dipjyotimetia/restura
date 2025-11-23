/**
 * File Collection Store
 *
 * Manages Git-native collections stored as YAML files on disk.
 * Works alongside useCollectionStore to sync changes to the file system.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Collection } from '@/types';
import { useCollectionStore } from './useCollectionStore';

// Sync state for tracking file vs memory state
export type SyncState = 'synced' | 'modified' | 'conflict' | 'loading' | 'error';

// Conflict information
export interface ConflictInfo {
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
  syncState: SyncState;
  lastSynced: number;
  isWatching: boolean;
  error?: string;
}

interface FileCollectionState {
  // Map of collection ID to file info
  fileCollections: Record<string, FileCollectionInfo>;

  // Active conflicts that need resolution
  conflicts: ConflictInfo[];

  // Default directory for new file collections
  defaultDirectory: string | null;

  // Actions
  registerFileCollection: (collectionId: string, directoryPath: string) => void;
  unregisterFileCollection: (collectionId: string) => void;
  updateSyncState: (collectionId: string, state: SyncState, error?: string) => void;
  markAsSynced: (collectionId: string) => void;
  setWatching: (collectionId: string, isWatching: boolean) => void;
  addConflict: (conflict: ConflictInfo) => void;
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
            (c) => !(c.collectionId === collectionId && (itemId === undefined || c.itemId === itemId))
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
      partialize: (state) => ({
        fileCollections: state.fileCollections,
        defaultDirectory: state.defaultDirectory,
      }),
    }
  )
);

// Type for electron API (available only in Electron)
interface ElectronCollectionsAPI {
  loadFromDirectory: (path: string) => Promise<{ success: boolean; collection?: any; error?: string }>;
  saveToDirectory: (collection: any, path: string) => Promise<{ success: boolean; error?: string }>;
  watchDirectory: (path: string) => Promise<{ success: boolean; error?: string }>;
  unwatchDirectory: (path: string) => Promise<{ success: boolean }>;
  selectDirectory: () => Promise<{ canceled: boolean; filePaths?: string[] }>;
  openInExplorer: (path: string) => Promise<{ success: boolean; error?: string }>;
  onFileChanged: (callback: (event: any) => void) => void;
  removeFileChangedListener: () => void;
}

// Get electron API if available
function getElectronCollections(): ElectronCollectionsAPI | null {
  if (typeof window !== 'undefined' && (window as any).electron?.collections) {
    return (window as any).electron.collections;
  }
  return null;
}

// Check if running in Electron
export function isElectronEnvironment(): boolean {
  return typeof window !== 'undefined' && (window as any).electron?.isElectron === true;
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
    // Add to collection store
    const collectionStore = useCollectionStore.getState();
    collectionStore.addCollection(result.collection as Collection);

    // Register as file collection
    const fileStore = useFileCollectionStore.getState();
    fileStore.registerFileCollection(result.collection.id, directoryPath);

    // Start watching
    await electron.watchDirectory(directoryPath);
    fileStore.setWatching(result.collection.id, true);

    return { success: true, collection: result.collection as Collection };
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
    const fileStore = useFileCollectionStore.getState();
    fileStore.registerFileCollection(collectionId, directoryPath);

    // Start watching
    const electron = getElectronCollections();
    if (electron) {
      await electron.watchDirectory(directoryPath);
      fileStore.setWatching(collectionId, true);
    }
  }

  return result;
}

// Initialize file watcher event handler
export function initFileCollectionWatcher(): void {
  const electron = getElectronCollections();
  if (!electron) return;

  electron.onFileChanged((event) => {
    const fileStore = useFileCollectionStore.getState();

    // Find which collection this file belongs to
    const fileInfo = Object.values(fileStore.fileCollections).find(
      (info) => event.directoryPath === info.directoryPath || event.filePath.startsWith(info.directoryPath)
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
