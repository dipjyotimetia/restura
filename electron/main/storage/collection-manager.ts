/**
 * Collection File Manager
 *
 * Manages Git-native collections stored as YAML files on disk.
 * Handles loading, saving, watching, and conflict detection.
 */

import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { internalToOC } from '@shared/opencollection/from-internal';
import { loadCollectionDirectory } from '@shared/opencollection/node/fs-reader';
import { saveCollectionToDir } from '@shared/opencollection/node/fs-writer';
import { ocToInternal } from '@shared/opencollection/to-internal';
import { createLogger } from '@shared/runtime/logger';
import { countBlankedAddresses } from '@shared/secrets/broker-preset-redaction';
import {
  countCollectionInlineSecrets,
  countVariableSecrets,
  redactCollectionSecrets,
} from '@shared/secrets/collection-redaction';
import { countRequestSecrets } from '@shared/secrets/request-secret-slots';
import type { Collection, CollectionRequest } from '@shared/types';
import type { FSWatcher } from 'chokidar';
import chokidar from 'chokidar';
import type { BrowserWindow, WebContents } from 'electron';
import { dialog, ipcMain, shell } from 'electron';
import { z } from 'zod';

const log = createLogger('collections');

/** What `redactCollectionSecrets` removes from a directory save. Names only, never values. */
export interface SaveRedactionNotices {
  /** Items holding auth, URL, broker or passthrough credentials that are not written. */
  credentialsRemovedFrom: string[];
  /** Kafka / MQTT presets with an address that reloads empty and needs re-entering. */
  addressesBlankedIn: string[];
}

/** A shape the counters cannot read is reported, and never fails the save it warns about. */
function countOrAssumeOne(count: () => number): number {
  try {
    return count();
  } catch {
    return 1;
  }
}

export function describeSaveRedactions(collection: FileCollection): SaveRedactionNotices {
  const credentialsRemovedFrom: string[] = [];
  const addressesBlankedIn: string[] = [];
  if (authHasPlaintextSecret(collection.auth) || countVariableSecrets(collection) > 0) {
    credentialsRemovedFrom.push('<collection>');
  }
  const visit = (items: FileCollectionItem[]): void => {
    for (const item of items) {
      const request = item.request as CollectionRequest | undefined;
      const inRequest =
        item.type === 'request' && request
          ? countOrAssumeOne(() => countRequestSecrets(request))
          : 0;
      if (
        inRequest > 0 ||
        authHasPlaintextSecret((item as { auth?: unknown }).auth) ||
        countVariableSecrets(item) > 0
      ) {
        credentialsRemovedFrom.push(item.name);
      }
      if (
        item.type === 'request' &&
        request &&
        countOrAssumeOne(() => countBlankedAddresses(request)) > 0
      ) {
        addressesBlankedIn.push(item.name);
      }
      if (item.items?.length) visit(item.items);
    }
  };
  visit(collection.items);
  // Passthrough bags and contract specs are not per-request.
  if (
    credentialsRemovedFrom.length === 0 &&
    countOrAssumeOne(() => countCollectionInlineSecrets(collection as unknown as Collection)) > 0
  ) {
    credentialsRemovedFrom.push('<collection>');
  }
  return { credentialsRemovedFrom, addressesBlankedIn };
}

/** For operators; the renderer gets the same names in the save result. */
function logSaveRedactions({
  credentialsRemovedFrom,
  addressesBlankedIn,
}: SaveRedactionNotices): void {
  if (credentialsRemovedFrom.length > 0) {
    log.warn('plaintext credentials not written on save — re-enter after import', {
      offenders: credentialsRemovedFrom,
    });
  }
  if (addressesBlankedIn.length > 0) {
    log.warn('broker / registry address saved blank — re-enter it without credentials', {
      offenders: addressesBlankedIn,
    });
  }
}

import { EVENT, IPC } from '../../shared/channels';
import { bindRendererCleanup } from '../ipc/connection-cleanup';
import {
  createValidatedEventHandler,
  createValidatedHandler,
  FilePathSchema,
  NoInputSchema,
} from '../ipc/ipc-validators';
import { authHasPlaintextSecret } from '../security/collection-export-redactor';
import { debounce } from '../util/debounce';
import { getAllowedRootForPath, grantCollectionRoot, isPathRealSafe } from './file-operations';

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

export interface FileCollection {
  id: string;
  name: string;
  description?: string;
  items: FileCollectionItem[];
  auth?: unknown;
  variables?: FileKeyValue[];
}

/**
 * One chokidar watcher per canonical directory, shared by every renderer
 * (webContents) that registered it. Owners are tracked per webContents id so a
 * window closing (or reloading) releases ONLY its own registrations: the
 * watcher — and with it the git/openInExplorer allowlist entry — survives while
 * any other window still owns it. File events go to the owners, not to
 * whichever window happens to be focused.
 */
interface ActiveWatcher {
  watcher: FSWatcher;
  /** Directory string as first registered (debounce/mtime keys use it). */
  directoryPath: string;
  owners: Map<number, WebContents>;
}
const activeWatchers = new Map<string, ActiveWatcher>();
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
  dirKey: string,
  payload: {
    type: 'modified' | 'added' | 'deleted';
    filePath: string;
    directoryPath: string;
    lastModified?: number;
  }
): void {
  const key = `${payload.directoryPath}::${payload.type}::${payload.filePath}`;
  let sender = debouncedSenders.get(key);
  if (!sender) {
    sender = debounce((p: unknown) => {
      // Resolve owners at flush time: one may have gone away during the debounce.
      const owners = activeWatchers.get(dirKey)?.owners;
      if (!owners) return;
      for (const wc of owners.values()) {
        if (!wc.isDestroyed()) wc.send(EVENT.collectionFileChanged, p);
      }
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
): Promise<{ success: boolean; error?: string; redactions?: SaveRedactionNotices }> {
  const dirKey = watcherKey(directoryPath);
  try {
    if (!(await isPathRealSafe(directoryPath))) {
      return { success: false, error: 'Access denied: Path is outside allowed directories' };
    }

    const redactions = describeSaveRedactions(collection);
    logSaveRedactions(redactions);
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
    await flushQueuedWatchEvents(dirKey, directoryPath, writeState);
    return redactions.credentialsRemovedFrom.length > 0 || redactions.addressesBlankedIn.length > 0
      ? { success: true, redactions }
      : { success: true };
  } catch (error) {
    const writeState = selfWriteStates.get(dirKey);
    if (writeState) {
      writeState.active = false;
      await flushQueuedWatchEvents(dirKey, directoryPath, writeState);
    }
    return { success: false, error: String(error) };
  }
}

async function flushQueuedWatchEvents(
  dirKey: string,
  directoryPath: string,
  state: SelfWriteState
): Promise<void> {
  const queued = state.queued.splice(0);
  for (const event of queued) {
    await handleWatchEvent(dirKey, directoryPath, event);
  }
}

async function handleWatchEvent(
  dirKey: string,
  directoryPath: string,
  event: PendingWatchEvent
): Promise<void> {
  const state = selfWriteStates.get(dirKey);
  if (state?.active) {
    const observedFingerprint =
      event.type === 'unlink' ? null : await fileFingerprint(event.filePath);
    const observedEvent = { ...event, observedFingerprint };
    if (state.active) state.queued.push(observedEvent);
    else await handleWatchEvent(dirKey, directoryPath, observedEvent);
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
      sendFileChange(dirKey, {
        type: 'modified',
        filePath: event.filePath,
        directoryPath,
        lastModified: stat.mtimeMs,
      });
    }
    fileModTimes.set(event.filePath, stat.mtimeMs);
    return;
  }
  if (event.type === 'add') {
    sendFileChange(dirKey, { type: 'added', filePath: event.filePath, directoryPath });
    return;
  }
  sendFileChange(dirKey, { type: 'deleted', filePath: event.filePath, directoryPath });
  fileModTimes.delete(event.filePath);
}

// Start watching a collection directory on behalf of `owner`.
async function watchCollectionDirectory(
  directoryPath: string,
  owner: WebContents
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!(await isPathRealSafe(directoryPath))) {
      return { success: false, error: 'Access denied: Path is outside allowed directories' };
    }

    // Replace any existing watcher (idempotent re-register), keeping its owners.
    const dirKey = watcherKey(directoryPath);
    const existing = activeWatchers.get(dirKey);
    if (existing) {
      void existing.watcher.close();
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
        void handleWatchEvent(dirKey, directoryPath, { type: 'change', filePath });
      })
      .on('add', (filePath) => {
        void handleWatchEvent(dirKey, directoryPath, { type: 'add', filePath });
      })
      .on('unlink', (filePath) => {
        void handleWatchEvent(dirKey, directoryPath, { type: 'unlink', filePath });
      })
      .on('error', (error) => {
        log.error('file watcher error', {
          error: error instanceof Error ? error.message : String(error),
        });
      });

    const owners = existing?.owners ?? new Map<number, WebContents>();
    owners.set(owner.id, owner);
    activeWatchers.set(dirKey, {
      watcher,
      directoryPath: existing?.directoryPath ?? directoryPath,
      owners,
    });
    // Release this renderer's registrations when it is destroyed or its
    // document is replaced (a reload re-registers via restoreFileCollectionWatchers).
    bindRendererCleanup(activeWatchers, owner, releaseWatchersOwnedBy);
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

/** Evict a directory's per-directory registries once nobody watches it. */
function forgetDirectoryState(dirKey: string, directoryPaths: Iterable<string>): void {
  selfWriteStates.delete(dirKey);
  loadedManagedFiles.delete(dirKey);
  // Evict this directory's debounced senders and file mtimes so the registries
  // don't accumulate entries across repeated watch/unwatch cycles.
  for (const directoryPath of new Set(directoryPaths)) {
    for (const key of debouncedSenders.keys()) {
      if (key.startsWith(`${directoryPath}::`)) debouncedSenders.delete(key);
    }
    const filePrefix = directoryPath + path.sep;
    for (const key of fileModTimes.keys()) {
      if (key === directoryPath || key.startsWith(filePrefix)) fileModTimes.delete(key);
    }
  }
}

/** Drop every registration owned by a gone renderer; close orphaned watchers. */
function releaseWatchersOwnedBy(ownerId: number): void {
  for (const [dirKey, entry] of activeWatchers) {
    if (!entry.owners.delete(ownerId) || entry.owners.size > 0) continue;
    activeWatchers.delete(dirKey);
    void entry.watcher.close();
    forgetDirectoryState(dirKey, [entry.directoryPath]);
  }
}

// Stop watching a collection directory on behalf of `ownerId`. The watcher
// closes only once no other renderer still owns it.
async function unwatchCollectionDirectory(
  directoryPath: string,
  ownerId: number
): Promise<{ success: boolean; error?: string }> {
  const dirKey = watcherKey(directoryPath);
  const entry = activeWatchers.get(dirKey);
  try {
    if (entry) {
      entry.owners.delete(ownerId);
      if (entry.owners.size > 0) return { success: true };
      activeWatchers.delete(dirKey);
      await entry.watcher.close();
    }
    forgetDirectoryState(dirKey, entry ? [directoryPath, entry.directoryPath] : [directoryPath]);
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
    createValidatedEventHandler(IPC.collection.watch, FilePathSchema, (directoryPath, event) => {
      return watchCollectionDirectory(directoryPath, event.sender);
    })
  );

  // Stop watching directory
  ipcMain.handle(
    IPC.collection.unwatch,
    createValidatedEventHandler(IPC.collection.unwatch, FilePathSchema, (directoryPath, event) => {
      return unwatchCollectionDirectory(directoryPath, event.sender.id);
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

      // A folder the user explicitly picks here becomes an allowed root (kept
      // across restarts). This is the only path that adds one; system roots and
      // credential folders are still refused by grantCollectionRoot.
      if (!result.canceled) {
        for (const picked of result.filePaths) await grantCollectionRoot(picked);
      }

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

// Global cleanup on app quit (per-window release is owner-scoped, above).
export function cleanupCollectionWatchers(): void {
  for (const { watcher } of activeWatchers.values()) {
    void watcher.close();
  }
  activeWatchers.clear();
  fileModTimes.clear();
  debouncedSenders.clear();
  selfWriteStates.clear();
  loadedManagedFiles.clear();
}
