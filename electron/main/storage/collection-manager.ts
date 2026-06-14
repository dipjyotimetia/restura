/**
 * Collection File Manager
 *
 * Manages Git-native collections stored as YAML files on disk.
 * Handles loading, saving, watching, and conflict detection.
 */

import type { BrowserWindow } from 'electron';
import { ipcMain, dialog, shell } from 'electron';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { FSWatcher } from 'chokidar';
import chokidar from 'chokidar';
import { z } from 'zod';
import { createValidatedHandler, FilePathSchema, NoInputSchema } from '../ipc/ipc-validators';
import { IPC, EVENT } from '../../shared/channels';
import { isPathSafe } from './file-operations';
import {
  redactAuthForExport,
  authHasPlaintextSecret,
} from '../security/collection-export-redactor';
import { createLogger } from '../../../src/lib/shared/logger';

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
import {
  fileKeyValueSchema,
  fileCollectionMetaSchema,
  fileFolderMetaSchema,
} from '../../../src/lib/shared/file-collection-schema';
import { debounce } from '../util/debounce';

// File extension constants (must match renderer types)
const FILE_EXTENSIONS = {
  COLLECTION_META: '_collection.yaml',
  FOLDER_META: '_folder.yaml',
  HTTP_REQUEST: '.http.yaml',
  GRPC_REQUEST: '.grpc.yaml',
} as const;

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

// Generate unique ID
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

// Add ID to key-value items
function addIdsToKeyValues(items: unknown) {
  const parsed = z.array(fileKeyValueSchema).safeParse(items);
  if (!parsed.success) return [];
  return parsed.data.map((item) => ({
    id: generateId(),
    key: item.key,
    value: item.value,
    enabled: item.enabled ?? true,
    description: item.description,
  }));
}

// Strip IDs from key-value items for file storage
function stripIdsFromKeyValues(
  items?: Array<{ id: string; key: string; value: string; enabled?: boolean; description?: string }>
) {
  if (!items) return undefined;
  return items.map(({ key, value, enabled, description }) => ({
    key,
    value,
    enabled: enabled ?? true,
    ...(description ? { description } : {}),
  }));
}

// Get request type from filename
function getRequestTypeFromFilename(filename: string): 'http' | 'grpc' | null {
  if (filename.endsWith(FILE_EXTENSIONS.HTTP_REQUEST)) return 'http';
  if (filename.endsWith(FILE_EXTENSIONS.GRPC_REQUEST)) return 'grpc';
  return null;
}

// Generate safe filename from name
function sanitizeFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// Load a single YAML file
async function loadYamlFile(filePath: string): Promise<unknown> {
  const content = await fsp.readFile(filePath, 'utf-8');
  return yaml.load(content, { schema: yaml.CORE_SCHEMA });
}

// Save a YAML file
async function saveYamlFile(filePath: string, data: unknown): Promise<void> {
  const content = yaml.dump(data, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });
  await fsp.writeFile(filePath, content, 'utf-8');
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

// Load collection from directory
async function loadCollectionFromDirectory(directoryPath: string): Promise<{
  success: boolean;
  collection?: unknown;
  error?: string;
}> {
  try {
    if (!isPathSafe(directoryPath)) {
      return { success: false, error: 'Access denied: Path is outside allowed directories' };
    }

    const dirStat = await statOrNull(directoryPath);
    if (!dirStat || !dirStat.isDirectory) {
      return { success: false, error: 'Directory does not exist' };
    }

    // Load collection metadata
    const metaPath = path.join(directoryPath, FILE_EXTENSIONS.COLLECTION_META);
    const metaStat = await statOrNull(metaPath);
    if (!metaStat) {
      return { success: false, error: 'No _collection.yaml found in directory' };
    }

    const metaData = await loadYamlFile(metaPath);
    const meta = fileCollectionMetaSchema.parse(metaData);

    // Track file mod time
    fileModTimes.set(metaPath, metaStat.mtimeMs);

    // Recursively load items
    const items = await loadDirectoryItems(directoryPath);

    const collection = {
      id: generateId(),
      name: meta.name,
      description: meta.description,
      items,
      auth: meta.auth,
      variables: addIdsToKeyValues(meta.variables),
      _filePath: directoryPath, // Track source directory
    };

    return { success: true, collection };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

// Load items from a directory (recursive). Children are loaded concurrently
// so a large collection on a network share doesn't pay round-trip latency
// per file/folder.
async function loadDirectoryItems(directoryPath: string): Promise<unknown[]> {
  const entries = await fsp.readdir(directoryPath, { withFileTypes: true });

  const loaded = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directoryPath, entry.name);

      if (entry.isDirectory()) {
        const folderMetaPath = path.join(entryPath, FILE_EXTENSIONS.FOLDER_META);
        let folderName = entry.name;
        let folderDescription: string | undefined;

        const folderMetaStat = await statOrNull(folderMetaPath);
        if (folderMetaStat) {
          try {
            const folderMeta = fileFolderMetaSchema.parse(await loadYamlFile(folderMetaPath));
            folderName = folderMeta.name;
            folderDescription = folderMeta.description;
            fileModTimes.set(folderMetaPath, folderMetaStat.mtimeMs);
          } catch {
            // Use directory name if meta is invalid
          }
        }

        const folderItems = await loadDirectoryItems(entryPath);

        return {
          id: generateId(),
          name: folderName,
          type: 'folder',
          items: folderItems,
          description: folderDescription,
          _filePath: entryPath,
        };
      }

      if (!entry.isFile()) return null;
      const requestType = getRequestTypeFromFilename(entry.name);
      if (!requestType) return null;

      try {
        const requestData = (await loadYamlFile(entryPath)) as Record<string, unknown>;
        const fileStat = await statOrNull(entryPath);
        if (fileStat) fileModTimes.set(entryPath, fileStat.mtimeMs);

        const request = {
          id: generateId(),
          type: requestType,
          ...requestData,
          headers: addIdsToKeyValues(requestData.headers),
          params: addIdsToKeyValues(requestData.params),
          metadata: addIdsToKeyValues(requestData.metadata),
        };

        return {
          id: generateId(),
          name: requestData.name || entry.name,
          type: 'request',
          request,
          _filePath: entryPath,
        };
      } catch (error) {
        log.error('failed to load request file', {
          path: entryPath,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    })
  );

  return loaded.filter((item): item is NonNullable<typeof item> => item !== null);
}

// Save collection to directory
async function saveCollectionToDirectory(
  collection: FileCollection,
  directoryPath: string
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isPathSafe(directoryPath)) {
      return { success: false, error: 'Access denied: Path is outside allowed directories' };
    }

    warnIfPlaintextSecretsWillBeDropped(collection);

    // Create directory if it doesn't exist
    await fsp.mkdir(directoryPath, { recursive: true });

    // Save collection metadata. Auth is redacted before write so plaintext
    // secrets never land in the YAML the user shares / commits to git — see
    // collection-export-redactor.ts.
    const meta = {
      name: collection.name,
      ...(collection.description ? { description: collection.description } : {}),
      ...(collection.auth ? { auth: redactAuthForExport(collection.auth) } : {}),
      ...(collection.variables?.length
        ? { variables: stripIdsFromKeyValues(collection.variables) }
        : {}),
    };

    await saveYamlFile(path.join(directoryPath, FILE_EXTENSIONS.COLLECTION_META), meta);

    // Save items recursively
    await saveDirectoryItems(collection.items, directoryPath);

    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

// Save items to directory (recursive). Siblings at each level write
// concurrently so large collection exports don't serialise per-file I/O.
async function saveDirectoryItems(
  items: FileCollectionItem[],
  directoryPath: string
): Promise<void> {
  await Promise.all(
    items.map(async (item) => {
      if (item.type === 'folder') {
        const folderPath = path.join(directoryPath, sanitizeFilename(item.name));
        await fsp.mkdir(folderPath, { recursive: true });

        const folderMeta = {
          name: item.name,
          ...(item.description ? { description: item.description } : {}),
        };
        await saveYamlFile(path.join(folderPath, FILE_EXTENSIONS.FOLDER_META), folderMeta);

        if (item.items?.length) {
          await saveDirectoryItems(item.items, folderPath);
        }
        return;
      }

      if (item.type !== 'request' || !item.request) return;
      const req = item.request;
      // Strip id and type before writing to disk; type is used to pick the extension.
      const { id: _id, type, ...requestData } = req;
      const extension =
        type === 'grpc' ? FILE_EXTENSIONS.GRPC_REQUEST : FILE_EXTENSIONS.HTTP_REQUEST;
      const filename = `${sanitizeFilename(item.name)}${extension}`;
      const filePath = path.join(directoryPath, filename);
      const fileData: Record<string, unknown> = {
        ...requestData,
        headers: stripIdsFromKeyValues(requestData.headers),
        params: stripIdsFromKeyValues(requestData.params),
        metadata: stripIdsFromKeyValues(requestData.metadata),
        // Redact secret-bearing auth fields. See collection-export-redactor.ts.
        ...(requestData.auth ? { auth: redactAuthForExport(requestData.auth) } : {}),
      };

      Object.keys(fileData).forEach((key) => {
        if (fileData[key] === undefined) delete fileData[key];
      });

      await saveYamlFile(filePath, fileData);
    })
  );
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
    if (activeWatchers.has(directoryPath)) {
      activeWatchers.get(directoryPath)?.close();
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
        // Async stat so a slow filesystem (network share, encrypted volume)
        // can't block the main thread inside the watcher callback.
        void (async () => {
          const stat = await statOrNull(filePath);
          if (!stat) return;
          const lastMod = fileModTimes.get(filePath);
          const currentMod = stat.mtimeMs;
          if (lastMod && currentMod > lastMod) {
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
        sendFileChange({ type: 'added', filePath, directoryPath }, getMainWindow);
      })
      .on('unlink', (filePath) => {
        sendFileChange({ type: 'deleted', filePath, directoryPath }, getMainWindow);
        fileModTimes.delete(filePath);
      })
      .on('error', (error) => {
        log.error('file watcher error', {
          error: error instanceof Error ? error.message : String(error),
        });
      });

    activeWatchers.set(directoryPath, watcher);
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

// Stop watching a collection directory
function unwatchCollectionDirectory(directoryPath: string): { success: boolean } {
  const watcher = activeWatchers.get(directoryPath);
  if (watcher) {
    watcher.close();
    activeWatchers.delete(directoryPath);
  }
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
}

// IPC validation schemas
const CollectionDataSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  items: z.array(z.unknown()),
  auth: z.unknown().optional(),
  variables: z.array(z.unknown()).optional(),
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
  return activeWatchers.has(directoryPath);
}

// Cleanup on app quit
export function cleanupCollectionWatchers(): void {
  for (const watcher of activeWatchers.values()) {
    watcher.close();
  }
  activeWatchers.clear();
  fileModTimes.clear();
  debouncedSenders.clear();
}
