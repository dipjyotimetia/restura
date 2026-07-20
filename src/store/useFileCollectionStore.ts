/**
 * File Collection Store
 *
 * Manages Git-native collections stored as YAML files on disk.
 * Works alongside useCollectionStore to sync changes to the file system.
 */

import { v4 as uuidv4 } from 'uuid';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { dexieStorageAdapters } from '@/lib/shared/dexie-storage';
import { isElectron } from '@/lib/shared/platform';
import type { Collection, CollectionItem, KeyValue, Request } from '@/types';
import type { ElectronAPI } from '../../electron/types/electron-api';
import { useCollectionStore } from './useCollectionStore';
import { useWorkflowStore } from './useWorkflowStore';

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

function getElectronOwsWorkspace(): ElectronAPI['owsWorkspace'] | null {
  if (typeof window !== 'undefined' && window.electron?.owsWorkspace) {
    return window.electron.owsWorkspace;
  }
  return null;
}

async function loadOwsWorkspaceForCollection(
  directoryPath: string,
  collectionId: string
): Promise<void> {
  const workspace = getElectronOwsWorkspace();
  if (!workspace) return;
  const listed = await workspace.list(directoryPath);
  if (!listed.ok) throw new Error(listed.error);
  const loaded = await Promise.all(
    listed.workflowIds.map(async (workspaceId) => {
      const result = await workspace.load(directoryPath, workspaceId);
      if (!result.ok) throw new Error(result.error);
      return { workspaceId, artifact: result.artifact };
    })
  );

  const workflowStore = useWorkflowStore.getState();
  const existing = new Map(
    workflowStore.workflows
      .filter((workflow) => workflow.collectionId === collectionId)
      .map((workflow) => [workflow.workspaceId ?? workflow.id, workflow])
  );
  workflowStore.removeWorkflowsByCollectionId(collectionId);
  const now = Date.now();
  for (const { workspaceId, artifact } of loaded) {
    const previous = existing.get(workspaceId);
    workflowStore.addWorkflow({
      id: previous?.id ?? uuidv4(),
      collectionId,
      workspaceId,
      document: artifact.workflow,
      bindings: artifact.bindings,
      layout: artifact.layout,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    });
  }
}

async function saveOwsWorkspaceForCollection(
  directoryPath: string,
  collectionId: string
): Promise<void> {
  const workspace = getElectronOwsWorkspace();
  if (!workspace) return;
  const workflowStore = useWorkflowStore.getState();
  const workflows = workflowStore.workflows.filter(
    (workflow) => workflow.collectionId === collectionId
  );
  const desired = new Set<string>();
  for (const workflow of workflows) {
    const workspaceId = workflow.workspaceId ?? workflow.id;
    desired.add(workspaceId);
    const result = await workspace.save(directoryPath, workspaceId, {
      workflow: workflow.document,
      bindings: workflow.bindings,
      layout: workflow.layout,
    });
    if (!result.ok) throw new Error(result.error);
  }
  const listed = await workspace.list(directoryPath);
  if (!listed.ok) throw new Error(listed.error);
  for (const workspaceId of listed.workflowIds) {
    if (desired.has(workspaceId)) continue;
    const result = await workspace.delete(directoryPath, workspaceId);
    if (!result.ok) throw new Error(result.error);
  }
}

export { isElectron as isElectronEnvironment };

/**
 * OpenCollection ids are runtime metadata rather than serialized fields. Match
 * a fresh disk parse back to the already-open tree so workflows and request
 * tabs keep pointing at the same logical objects after an external reload.
 */
export function reconcileCollectionIds(existing: Collection, incoming: Collection): Collection {
  incoming.id = existing.id;
  incoming.variables = reconcileKeyValues(existing.variables, incoming.variables);

  const pool: CollectionItem[] = [];
  const collect = (items: CollectionItem[]): void => {
    for (const item of items) {
      pool.push(item);
      if (item.items) collect(item.items);
    }
  };
  collect(existing.items);
  const used = new Set<CollectionItem>();

  const reconcileItems = (
    previousSiblings: CollectionItem[],
    nextSiblings: CollectionItem[]
  ): CollectionItem[] => {
    const matches = new Map<CollectionItem, CollectionItem>();

    // Claim every exact logical match before considering positional rename
    // fallback. This prevents a newly inserted sibling from stealing an id
    // that belongs to an unchanged item later in the array.
    for (const next of nextSiblings) {
      const exact = previousSiblings.find(
        (item) => !used.has(item) && item.type === next.type && item.name === next.name
      );
      if (exact) {
        used.add(exact);
        matches.set(next, exact);
      }
    }
    for (const next of nextSiblings) {
      if (matches.has(next)) continue;
      const globalExact = pool.filter(
        (item) => !used.has(item) && item.type === next.type && item.name === next.name
      );
      if (globalExact.length === 1 && globalExact[0]) {
        used.add(globalExact[0]);
        matches.set(next, globalExact[0]);
      }
    }

    const unmatchedNext = nextSiblings.filter((item) => !matches.has(item));
    const unmatchedPrevious = previousSiblings.filter((item) => !used.has(item));
    if (unmatchedNext.length === unmatchedPrevious.length) {
      unmatchedNext.forEach((next, index) => {
        const previous = unmatchedPrevious[index];
        if (previous?.type === next.type) {
          used.add(previous);
          matches.set(next, previous);
        }
      });
    }

    return nextSiblings.map((next) => {
      const previous = matches.get(next);
      if (!previous) return next;

      next.id = previous.id;
      if (next.request && previous.request) {
        next.request = reconcileRequestIds(previous.request, next.request);
      }
      if (next.items) next.items = reconcileItems(previous.items ?? [], next.items);
      return next;
    });
  };

  incoming.items = reconcileItems(existing.items, incoming.items);
  return incoming;
}

function reconcileRequestIds(existing: Request, incoming: Request): Request {
  incoming.id = existing.id;
  const oldRecord = existing as unknown as Record<string, unknown>;
  const newRecord = incoming as unknown as Record<string, unknown>;
  for (const key of ['headers', 'params', 'metadata']) {
    newRecord[key] = reconcileKeyValues(
      oldRecord[key] as KeyValue[] | undefined,
      newRecord[key] as KeyValue[] | undefined
    );
  }
  return incoming;
}

function reconcileKeyValues(
  existing: KeyValue[] | undefined,
  incoming: KeyValue[] | undefined
): KeyValue[] | undefined {
  if (!incoming || !existing) return incoming;
  const used = new Set<KeyValue>();
  const matches = new Map<KeyValue, KeyValue>();
  for (const next of incoming) {
    const exact = existing.find((item) => !used.has(item) && item.key === next.key);
    if (exact) {
      used.add(exact);
      matches.set(next, exact);
    }
  }
  const unmatchedNext = incoming.filter((item) => !matches.has(item));
  const unmatchedExisting = existing.filter((item) => !used.has(item));
  if (unmatchedNext.length === unmatchedExisting.length) {
    unmatchedNext.forEach((next, index) => {
      const previous = unmatchedExisting[index];
      if (previous) matches.set(next, previous);
    });
  }
  return incoming.map((next) => {
    const previous = matches.get(next);
    if (previous) {
      next.id = previous.id;
    }
    return next;
  });
}

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
    const openCollection = collectionStore.getCollectionById(collection.id);
    if (openCollection) {
      reconcileCollectionIds(openCollection, collection);
      collectionStore.updateCollection(collection.id, collection);
    } else {
      collectionStore.addCollection(collection);
    }

    // Register as file collection
    fileStore.registerFileCollection(collection.id, directoryPath);

    // Start watching (the active-watcher set is the git allowlist).
    await startWatching(collection.id, directoryPath);

    try {
      await loadOwsWorkspaceForCollection(directoryPath, collection.id);
    } catch (error) {
      fileStore.updateSyncState(
        collection.id,
        'error',
        error instanceof Error ? error.message : String(error)
      );
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }

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

  const result = await saveCollectionToDirectory(collection, fileInfo.directoryPath);
  if (!result.success) return result;
  try {
    await saveOwsWorkspaceForCollection(fileInfo.directoryPath, collectionId);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fileStore.updateSyncState(collectionId, 'error', message);
    return { success: false, error: message };
  }
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
    try {
      await saveOwsWorkspaceForCollection(directoryPath, collectionId);
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
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
    Object.values(fileCollections).map(async (info) => {
      try {
        // Loading is also reconciliation: disk is authoritative after a
        // restart, and load registers the watcher after replacing the in-memory
        // collection under the existing directory identity.
        const result = await loadCollectionFromDirectory(info.directoryPath);
        if (!result.success) setWatching(info.collectionId, false);
      } catch {
        setWatching(info.collectionId, false);
      }
    })
  );
}

// Initialize file watcher event handler
let unsubscribeCollectionChanges: (() => void) | null = null;
const externalReloads = new Map<string, Promise<unknown>>();
const pendingExternalReloads = new Set<string>();

export function initFileCollectionWatcher(): void {
  const electron = getElectronCollections();
  if (!electron) return;

  unsubscribeCollectionChanges?.();
  unsubscribeCollectionChanges = useCollectionStore.subscribe((state, previous) => {
    const fileStore = useFileCollectionStore.getState();
    for (const info of Object.values(fileStore.fileCollections)) {
      const current = state.collections.find((collection) => collection.id === info.collectionId);
      const before = previous.collections.find((collection) => collection.id === info.collectionId);
      if (current !== before && before && info.syncState === 'synced') {
        fileStore.updateSyncState(info.collectionId, 'modified');
      }
    }
  });

  electron.onFileChanged((event) => {
    const fileStore = useFileCollectionStore.getState();

    // Find which collection this file belongs to
    const fileInfo = Object.values(fileStore.fileCollections).find(
      (info) => event.directoryPath === info.directoryPath
    );

    if (!fileInfo) return;

    if (fileInfo.syncState === 'modified' || fileInfo.syncState === 'loading') {
      fileStore.addConflict({
        collectionId: fileInfo.collectionId,
        itemName: event.filePath.split('/').pop() || 'Unknown',
        filePath: event.filePath,
        localModified: fileInfo.lastSynced,
        externalModified: event.lastModified || Date.now(),
        message: 'Files changed externally while this collection has unsaved local changes',
      });
      fileStore.updateSyncState(fileInfo.collectionId, 'conflict');
      return;
    }

    // A clean collection can be safely reloaded in place. Coalesce bursts from
    // multi-file git checkouts into one reload per collection.
    if (externalReloads.has(fileInfo.collectionId)) {
      pendingExternalReloads.add(fileInfo.collectionId);
      return;
    }

    const scheduleReload = () =>
      loadCollectionFromDirectory(fileInfo.directoryPath)
        .then((result) => {
          if (!result.success) {
            fileStore.updateSyncState(fileInfo.collectionId, 'error', result.error);
          }
        })
        .catch((error: unknown) => {
          fileStore.updateSyncState(
            fileInfo.collectionId,
            'error',
            error instanceof Error ? error.message : String(error)
          );
        })
        .finally(() => {
          externalReloads.delete(fileInfo.collectionId);
          if (pendingExternalReloads.delete(fileInfo.collectionId)) {
            const nextReload = scheduleReload();
            externalReloads.set(fileInfo.collectionId, nextReload);
          }
        });
    const reload = scheduleReload();
    externalReloads.set(fileInfo.collectionId, reload);
  });
}

// Cleanup file watcher
export function cleanupFileCollectionWatcher(): void {
  unsubscribeCollectionChanges?.();
  unsubscribeCollectionChanges = null;
  externalReloads.clear();
  pendingExternalReloads.clear();
  const electron = getElectronCollections();
  if (electron) {
    electron.removeFileChangedListener();
  }
}
