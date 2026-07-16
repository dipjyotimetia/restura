/**
 * Collection File Manager
 *
 * Manages Git-native collections stored as YAML files on disk.
 * Handles loading, saving, watching, and conflict detection.
 */

import { createHash } from 'node:crypto';
import type { FSWatcher } from 'chokidar';
import chokidar from 'chokidar';
import type { BrowserWindow } from 'electron';
import { dialog, ipcMain, shell } from 'electron';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { z } from 'zod';
import { internalToOC } from '@shared/opencollection/from-internal';
import { loadCollectionDirectory } from '@shared/opencollection/node/fs-reader';
import { saveCollectionToDir } from '@shared/opencollection/node/fs-writer';
import { ocToInternal } from '@shared/opencollection/to-internal';
import { redactCollectionSecrets } from '@shared/secrets/collection-redaction';
import { createLogger } from '@shared/runtime/logger';
import type { Collection } from '@shared/types';

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

import { EVENT, IPC } from '../../shared/channels';
import { createValidatedHandler, FilePathSchema, NoInputSchema } from '../ipc/ipc-validators';
import { authHasPlaintextSecret } from '../security/collection-export-redactor';
import { debounce } from '../util/debounce';
import { getAllowedRootForPath, isPathRealSafe } from './file-operations';

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
// Ownership established during a load is used only to bootstrap the first
// manifest-backed save. Subsequent saves read the durable manifest directly.
const loadedManagedFiles = new Map<string, string[]>();
type WatchEventType = 'change' | 'add' | 'unlink';
interface PendingWatchEvent {
  type: WatchEventType;
  filePath: string;
  /** Content observed when the event arrived, before a later write can replace it. */
  observedFingerprint?: string | null;
}
interface SelfWriteState {
  active: boolean;
  /** Expected post-save content hash, or null when Restura deleted the file. */
  expected: Map<string, string | null>;
  queued: PendingWatchEvent[];
}
// Suppression is content-based: concurrent external edits never disappear just
// because they happen during a Restura save.
const selfWriteStates = new Map<string, SelfWriteState>();

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

async function fileFingerprint(filePath: string): Promise<string | null> {
  try {
    return createHash('sha256')
      .update(await fsp.readFile(filePath))
      .digest('hex');
  } catch {
    return null;
  }
}

async function expectedFingerprints(
  directoryPath: string,
  managedFiles: string[],
  removedFiles: string[] = []
): Promise<Map<string, string | null>> {
  const expected = new Map<string, string | null>();
  await Promise.all(
    managedFiles.map(async (relativePath) => {
      const filePath = resolveManagedFile(directoryPath, relativePath);
      if (!filePath) return;
      expected.set(filePath, await fileFingerprint(filePath));
    })
  );
  for (const relativePath of removedFiles) {
    const filePath = resolveManagedFile(directoryPath, relativePath);
    if (filePath) expected.set(filePath, null);
  }
  return expected;
}

function resolveManagedFile(directoryPath: string, relativePath: string): string | null {
  if (path.isAbsolute(relativePath) || !/\.ya?ml$/i.test(relativePath)) return null;
  const root = path.resolve(directoryPath);
  const target = path.resolve(root, relativePath);
  return target.startsWith(root + path.sep) ? target : null;
}

async function managedFilesFromManifest(directoryPath: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(
      await fsp.readFile(path.join(directoryPath, '.restura-managed-files.json'), 'utf8')
    ) as { version?: unknown; files?: unknown };
    return parsed.version === 1 && Array.isArray(parsed.files)
      ? parsed.files.filter((file): file is string => typeof file === 'string')
      : [];
  } catch {
    return [];
  }
}

async function loadCollectionFromDirectory(directoryPath: string): Promise<{
  success: boolean;
  collection?: unknown;
  error?: string;
}> {
  if (!(await isPathRealSafe(directoryPath))) {
    return { success: false, error: 'Access denied: Path is outside allowed directories' };
  }

  const hasOpenCollection =
    (await statOrNull(path.join(directoryPath, 'opencollection.yml'))) !== null ||
    (await statOrNull(path.join(directoryPath, 'opencollection.yaml'))) !== null;
  if (hasOpenCollection) {
    try {
      const loaded = await loadCollectionDirectory(directoryPath);
      loadedManagedFiles.set(watcherKey(directoryPath), loaded.managedFiles);
      const collection = ocToInternal(loaded.collection);
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
    if (!(await isPathRealSafe(directoryPath))) {
      return { success: false, error: 'Access denied: Path is outside allowed directories' };
    }

    warnIfPlaintextSecretsWillBeDropped(collection);
    const previousManagedFiles =
      loadedManagedFiles.get(dirKey) ?? (await managedFilesFromManifest(directoryPath));
    const before = await expectedFingerprints(directoryPath, previousManagedFiles);
    const expectedManifestFingerprint = await fileFingerprint(
      path.join(directoryPath, '.restura-managed-files.json')
    );
    const expectedPreviousFingerprints = Object.fromEntries(
      [...before].map(([filePath, fingerprint]) => [
        path.relative(directoryPath, filePath).split(path.sep).join('/'),
        fingerprint,
      ])
    );
    const writeState: SelfWriteState = { active: true, expected: before, queued: [] };
    selfWriteStates.set(dirKey, writeState);
    const safeCollection = redactCollectionSecrets(collection as Collection);
    const trustedRoot = getAllowedRootForPath(directoryPath);
    if (!trustedRoot) {
      return { success: false, error: 'Access denied: Path is outside allowed directories' };
    }
    const saveResult = await saveCollectionToDir(internalToOC(safeCollection), directoryPath, {
      previousManagedFiles,
      expectedPreviousFingerprints,
      expectedManifestFingerprint,
      trustedRoot,
    });
    loadedManagedFiles.delete(dirKey);
    writeState.expected = new Map(
      Object.entries(saveResult.fingerprints).map(([relativePath, fingerprint]) => [
        resolveManagedFile(directoryPath, relativePath)!,
        fingerprint,
      ])
    );
    for (const relativePath of saveResult.removedFiles) {
      const filePath = resolveManagedFile(directoryPath, relativePath);
      if (filePath) writeState.expected.set(filePath, null);
    }
    writeState.active = false;
    await flushQueuedWatchEvents(dirKey, directoryPath, writeState, getMainWindowForWatchers);
    return { success: true };
  } catch (error) {
    const writeState = selfWriteStates.get(dirKey);
    if (writeState) {
      writeState.active = false;
      await flushQueuedWatchEvents(dirKey, directoryPath, writeState, getMainWindowForWatchers);
    }
    return { success: false, error: String(error) };
  }
}

let getMainWindowForWatchers: () => BrowserWindow | null = () => null;

async function flushQueuedWatchEvents(
  dirKey: string,
  directoryPath: string,
  state: SelfWriteState,
  getMainWindow: () => BrowserWindow | null
): Promise<void> {
  const queued = state.queued.splice(0);
  for (const event of queued) {
    await handleWatchEvent(dirKey, directoryPath, event, getMainWindow);
  }
}

async function handleWatchEvent(
  dirKey: string,
  directoryPath: string,
  event: PendingWatchEvent,
  getMainWindow: () => BrowserWindow | null
): Promise<void> {
  const state = selfWriteStates.get(dirKey);
  if (state?.active) {
    const observedFingerprint =
      event.type === 'unlink' ? null : await fileFingerprint(event.filePath);
    const observedEvent = { ...event, observedFingerprint };
    if (state.active) state.queued.push(observedEvent);
    else await handleWatchEvent(dirKey, directoryPath, observedEvent, getMainWindow);
    return;
  }
  if (state?.expected.has(event.filePath)) {
    const expected = state.expected.get(event.filePath);
    const actual =
      'observedFingerprint' in event
        ? event.observedFingerprint
        : event.type === 'unlink'
          ? null
          : await fileFingerprint(event.filePath);
    if (expected === actual) {
      return;
    }
  }

  if (event.type === 'change') {
    const stat = await statOrNull(event.filePath);
    if (!stat) return;
    const lastMod = fileModTimes.get(event.filePath);
    if (lastMod === undefined || stat.mtimeMs > lastMod) {
      sendFileChange(
        {
          type: 'modified',
          filePath: event.filePath,
          directoryPath,
          lastModified: stat.mtimeMs,
        },
        getMainWindow
      );
    }
    fileModTimes.set(event.filePath, stat.mtimeMs);
    return;
  }
  if (event.type === 'add') {
    sendFileChange({ type: 'added', filePath: event.filePath, directoryPath }, getMainWindow);
    return;
  }
  sendFileChange({ type: 'deleted', filePath: event.filePath, directoryPath }, getMainWindow);
  fileModTimes.delete(event.filePath);
}

// Start watching a collection directory
async function watchCollectionDirectory(
  directoryPath: string,
  getMainWindow: () => BrowserWindow | null
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!(await isPathRealSafe(directoryPath))) {
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
      followSymlinks: false,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    watcher
      .on('change', (filePath) => {
        void handleWatchEvent(dirKey, directoryPath, { type: 'change', filePath }, getMainWindow);
      })
      .on('add', (filePath) => {
        void handleWatchEvent(dirKey, directoryPath, { type: 'add', filePath }, getMainWindow);
      })
      .on('unlink', (filePath) => {
        void handleWatchEvent(dirKey, directoryPath, { type: 'unlink', filePath }, getMainWindow);
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
    selfWriteStates.delete(dirKey);
    loadedManagedFiles.delete(dirKey);
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
  getMainWindowForWatchers = getMainWindow;
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
  selfWriteStates.clear();
  loadedManagedFiles.clear();
}
