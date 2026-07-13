/**
 * Collection File Manager
 *
 * Manages Git-native collections stored as YAML files on disk.
 * Handles loading, saving, watching, and conflict detection.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import type { FSWatcher } from 'chokidar';
import chokidar from 'chokidar';
import { ipcMain, dialog, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { z } from 'zod';
import { internalToOC } from '../../../src/lib/opencollection/from-internal';
import { loadCollectionFromDir } from '../../../src/lib/opencollection/fs-reader';
import { saveCollectionToDir } from '../../../src/lib/opencollection/fs-writer';
import { ocToInternal } from '../../../src/lib/opencollection/to-internal';
import { redactCollectionSecrets } from '../../../src/lib/shared/collection-secret-redaction';
import { createLogger } from '../../../src/lib/shared/logger';
import type { Collection } from '../../../src/types';

const log = createLogger('collections');

/**
 * Walks the collection tree and emits a single warning to main-process stdout
 * if ANY request (or the collection itself) carries a plaintext secret that
 * `redactAuthForExport` will drop on save. Surfaced here so operators have
 * visibility — the IPC contract doesn't currently bubble warnings back to
 * the renderer for per-export advisories.
 */
function warnIfPlaintextSecretsWillBeDropped(collection: FileCollection): void {
  const offenders: string[] = [];
  if (authHasPlaintextSecret(collection.auth)) offenders.push('<collection>');
  const visit = (items: FileCollectionItem[]): void => {
    for (const item of items) {
      if (
        item.type === 'request' &&
        item.request &&
        authHasPlaintextSecret((item.request as Record<string, unknown>).auth)
      ) {
        offenders.push(item.name);
      }
      if (item.items?.length) visit(item.items);
    }
  };
  visit(collection.items);
  if (offenders.length > 0) {
    log.warn('plaintext auth secrets redacted on export — re-enter after import', {
      offenders,
    });
  }
}
import { IPC, EVENT } from '../../shared/channels';
import { createValidatedHandler, FilePathSchema, NoInputSchema } from '../ipc/ipc-validators';
import { authHasPlaintextSecret } from '../security/collection-export-redactor';
import { debounce } from '../util/debounce';
import { isPathSafe } from './file-operations';

interface FileKeyValue {
  id: string;
  key: string;
  value: string;
  enabled?: boolean;
  description?: string;
}

interface FileRequest {
  id: string;
  type: string;
  headers?: FileKeyValue[];
  params?: FileKeyValue[];
  metadata?: FileKeyValue[];
  [key: string]: unknown;
}

interface FileCollectionItem {
  type: 'folder' | 'request';
  name: string;
  description?: string;
  request?: FileRequest;
  items?: FileCollectionItem[];
}

interface FileCollection {
  id: string;
  name: string;
  description?: string;
  items: FileCollectionItem[];
  auth?: unknown;
  variables?: FileKeyValue[];
}

// Track active file watchers
const activeWatchers = new Map<string, FSWatcher>();
// Saves are staged and then copied into place, which produces several watcher
// events. Suppress only the saving directory for a short bounded window so the
// renderer never reports Restura's own write as an external conflict.
const selfWriteUntil = new Map<string, number>();

/**
 * Canonical key for the active-watcher set. The git handler (and
 * `openInExplorer`) check this allowlist after `path.resolve`, so the set must
 * be keyed by the canonical path too — otherwise a non-canonical directory
 * string (trailing slash, `..`, mixed separators) registers under one key but is
 * checked under another, and every git op false-denies. Only the Map key is
 * canonicalised; chokidar still watches, and file-change events still report,
 * the original string, so the renderer's own (raw) bookkeeping is untouched.
 */
function watcherKey(directoryPath: string): string {
  return path.resolve(directoryPath);
}

// Track file modification times for conflict detection
const fileModTimes = new Map<string, number>();

const FILE_CHANGE_DEBOUNCE_MS = 250;
// Cache of debounced sender functions, keyed by (directoryPath::type::filePath).
// Each unique (path, type) pair gets its own debounced flusher so distinct events
// across files can still fire in parallel; only repeat events for the same pair
// coalesce.
const debouncedSenders = new Map<string, (payload: unknown) => void>();

function sendFileChange(
  payload: {
    type: 'modified' | 'added' | 'deleted';
    filePath: string;
    directoryPath: string;
    lastModified?: number;
  },
  getMainWindow: () => BrowserWindow | null
): void {
  const key = `${payload.directoryPath}::${payload.type}::${payload.filePath}`;
  let sender = debouncedSenders.get(key);
  if (!sender) {
    sender = debounce((p: unknown) => {
      const w = getMainWindow();
      if (w) w.webContents.send(EVENT.collectionFileChanged, p);
    }, FILE_CHANGE_DEBOUNCE_MS);
    debouncedSenders.set(key, sender);
  }
  sender(payload);
}

// stat that returns null on ENOENT/EACCES instead of throwing.
async function statOrNull(
  p: string
): Promise<{ mtimeMs: number; size: number; isDirectory: boolean } | null> {
  try {
    const s = await fsp.stat(p);
    return { mtimeMs: s.mtimeMs, size: s.size, isDirectory: s.isDirectory() };
  } catch {
    return null;
  }
}

async function loadCollectionFromDirectory(directoryPath: string): Promise<{
  success: boolean;
  collection?: unknown;
  error?: string;
}> {
  if (!isPathSafe(directoryPath)) {
    return { success: false, error: 'Access denied: Path is outside allowed directories' };
  }

  const hasOpenCollection =
    (await statOrNull(path.join(directoryPath, 'opencollection.yml'))) !== null ||
    (await statOrNull(path.join(directoryPath, 'opencollection.yaml'))) !== null;
  if (hasOpenCollection) {
    try {
      const collection = ocToInternal(await loadCollectionFromDir(directoryPath));
      (collection as Collection & { _filePath?: string })._filePath = directoryPath;
      return { success: true, collection };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  return {
    success: false,
    error:
      'Unsupported collection directory: opencollection.yml or opencollection.yaml is required',
  };
}

// Save collection to directory
async function saveCollectionToDirectory(
  collection: FileCollection,
  directoryPath: string
): Promise<{ success: boolean; error?: string }> {
  const dirKey = watcherKey(directoryPath);
  try {
    if (!isPathSafe(directoryPath)) {
      return { success: false, error: 'Access denied: Path is outside allowed directories' };
    }

    warnIfPlaintextSecretsWillBeDropped(collection);
    selfWriteUntil.set(dirKey, Number.POSITIVE_INFINITY);
    const safeCollection = redactCollectionSecrets(collection as Collection);
    await saveCollectionToDir(internalToOC(safeCollection), directoryPath);
    selfWriteUntil.set(dirKey, Date.now() + 1_000);
    return { success: true };
  } catch (error) {
    selfWriteUntil.set(dirKey, Date.now() + 1_000);
    return { success: false, error: String(error) };
  }
}

// Start watching a collection directory
function watchCollectionDirectory(
  directoryPath: string,
  getMainWindow: () => BrowserWindow | null
): { success: boolean; error?: string } {
  try {
    if (!isPathSafe(directoryPath)) {
      return { success: false, error: 'Access denied: Path is outside allowed directories' };
    }

    // Stop existing watcher if any
    const dirKey = watcherKey(directoryPath);
    if (activeWatchers.has(dirKey)) {
      activeWatchers.get(dirKey)?.close();
    }

    const watcher = chokidar.watch(directoryPath, {
      ignored: /(^|[/\\])\../, // Ignore dotfiles
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    watcher
      .on('change', (filePath) => {
        if ((selfWriteUntil.get(dirKey) ?? 0) >= Date.now()) return;
        // Async stat so a slow filesystem (network share, encrypted volume)
        // can't block the main thread inside the watcher callback.
        void (async () => {
          const stat = await statOrNull(filePath);
          if (!stat) return;
          const lastMod = fileModTimes.get(filePath);
          const currentMod = stat.mtimeMs;
          if (lastMod === undefined || currentMod > lastMod) {
            sendFileChange(
              {
                type: 'modified',
                filePath,
                directoryPath,
                lastModified: currentMod,
              },
              getMainWindow
            );
          }
          fileModTimes.set(filePath, currentMod);
        })();
      })
      .on('add', (filePath) => {
        if ((selfWriteUntil.get(dirKey) ?? 0) >= Date.now()) return;
        sendFileChange({ type: 'added', filePath, directoryPath }, getMainWindow);
      })
      .on('unlink', (filePath) => {
        if ((selfWriteUntil.get(dirKey) ?? 0) >= Date.now()) return;
        sendFileChange({ type: 'deleted', filePath, directoryPath }, getMainWindow);
        fileModTimes.delete(filePath);
      })
      .on('error', (error) => {
        log.error('file watcher error', {
          error: error instanceof Error ? error.message : String(error),
        });
      });

    activeWatchers.set(dirKey, watcher);
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

// Stop watching a collection directory
async function unwatchCollectionDirectory(
  directoryPath: string
): Promise<{ success: boolean; error?: string }> {
  const dirKey = watcherKey(directoryPath);
  const watcher = activeWatchers.get(dirKey);
  try {
    if (watcher) {
      await watcher.close();
      activeWatchers.delete(dirKey);
    }
    selfWriteUntil.delete(dirKey);
    // Evict this directory's debounced senders and file mtimes so the registries
    // don't accumulate entries across repeated watch/unwatch cycles.
    for (const key of debouncedSenders.keys()) {
      if (key.startsWith(`${directoryPath}::`)) debouncedSenders.delete(key);
    }
    const filePrefix = directoryPath + path.sep;
    for (const key of fileModTimes.keys()) {
      if (key === directoryPath || key.startsWith(filePrefix)) fileModTimes.delete(key);
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// IPC validation schemas
const CollectionDataSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  items: z.array(z.unknown()),
  auth: z.unknown().optional(),
  variables: z.array(z.unknown()).optional(),
  contractSpec: z.unknown().optional(),
  preRequestScript: z.string().optional(),
  testScript: z.string().optional(),
  // OpenCollection provenance preserves unknown spec fields/extensions across
  // a load-edit-save cycle. Nested bags survive because items are validated at
  // the renderer store boundary and remain opaque at IPC transport.
  _oc: z.unknown().optional(),
});

const SaveCollectionSchema = z.tuple([CollectionDataSchema, FilePathSchema]);

// Register IPC handlers
export function registerCollectionManagerIPC(getMainWindow: () => BrowserWindow | null): void {
  // Load collection from directory
  ipcMain.handle(
    IPC.collection.loadDirectory,
    createValidatedHandler(
      IPC.collection.loadDirectory,
      FilePathSchema,
      async (directoryPath: string) => {
        return loadCollectionFromDirectory(directoryPath);
      }
    )
  );

  // Save collection to directory
  ipcMain.handle(
    IPC.collection.saveDirectory,
    createValidatedHandler(
      IPC.collection.saveDirectory,
      SaveCollectionSchema,
      async ([collection, directoryPath]) => {
        return saveCollectionToDirectory(collection as FileCollection, directoryPath);
      }
    )
  );

  // Start watching directory
  ipcMain.handle(
    IPC.collection.watch,
    createValidatedHandler(IPC.collection.watch, FilePathSchema, (directoryPath: string) => {
      return watchCollectionDirectory(directoryPath, getMainWindow);
    })
  );

  // Stop watching directory
  ipcMain.handle(
    IPC.collection.unwatch,
    createValidatedHandler(IPC.collection.unwatch, FilePathSchema, (directoryPath: string) => {
      return unwatchCollectionDirectory(directoryPath);
    })
  );

  // Open directory in file manager
  ipcMain.handle(
    IPC.collection.openInExplorer,
    createValidatedHandler(
      IPC.collection.openInExplorer,
      FilePathSchema,
      async (directoryPath: string) => {
        // Restrict to directories the renderer has registered as file-backed
        // collections (active watcher) — the same allowlist the git handler
        // uses. Without this, a compromised renderer could shell.openPath() an
        // arbitrary file, which launches it via its default OS handler.
        if (!isRegisteredCollectionDirectory(directoryPath)) {
          return { success: false, error: 'Access denied' };
        }
        const stat = await statOrNull(directoryPath);
        if (!stat?.isDirectory) {
          return { success: false, error: 'Access denied: not a directory' };
        }
        await shell.openPath(directoryPath);
        return { success: true };
      }
    )
  );

  // Select directory dialog. Wrapped in createValidatedHandler so the channel
  // routes through assertTrustedSender — input is empty but the wrapper still
  // enforces the trust check.
  ipcMain.handle(
    IPC.collection.selectDirectory,
    createValidatedHandler(IPC.collection.selectDirectory, NoInputSchema, async () => {
      const mainWindow = getMainWindow();
      if (!mainWindow) return { canceled: true };

      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory', 'createDirectory'],
        title: 'Select Collection Directory',
      });

      return result;
    })
  );

  // Get file info for conflict detection
  ipcMain.handle(
    IPC.collection.getFileInfo,
    createValidatedHandler(IPC.collection.getFileInfo, FilePathSchema, async (filePath: string) => {
      if (!isPathWithinRegisteredCollection(filePath)) {
        return { exists: false, error: 'Access denied' };
      }
      const stat = await statOrNull(filePath);
      if (!stat) return { exists: false };
      return {
        exists: true,
        lastModified: stat.mtimeMs,
        size: stat.size,
      };
    })
  );
}

/**
 * True iff `directoryPath` is registered as a file-backed collection root
 * (i.e. has an active chokidar watcher). Other main-process modules (e.g.
 * the git handler) consult this to refuse operations on arbitrary
 * directories, keeping the trust boundary tight.
 */
export function isRegisteredCollectionDirectory(directoryPath: string): boolean {
  return activeWatchers.has(watcherKey(directoryPath));
}

function isPathWithinRegisteredCollection(filePath: string): boolean {
  const candidate = path.resolve(filePath);
  for (const root of activeWatchers.keys()) {
    if (candidate === root || candidate.startsWith(`${root}${path.sep}`)) return true;
  }
  return false;
}

// Cleanup on app quit
export function cleanupCollectionWatchers(): void {
  for (const watcher of activeWatchers.values()) {
    watcher.close();
  }
  activeWatchers.clear();
  fileModTimes.clear();
  debouncedSenders.clear();
  selfWriteUntil.clear();
}
