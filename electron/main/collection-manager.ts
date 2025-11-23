/**
 * Collection File Manager
 *
 * Manages Git-native collections stored as YAML files on disk.
 * Handles loading, saving, watching, and conflict detection.
 */

import { ipcMain, BrowserWindow, dialog, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import chokidar, { FSWatcher } from 'chokidar';
import { z } from 'zod';
import { createValidatedHandler, FilePathSchema } from './ipc-validators';
import { isPathSafe } from './file-operations';

// File extension constants (must match renderer types)
const FILE_EXTENSIONS = {
  COLLECTION_META: '_collection.yaml',
  FOLDER_META: '_folder.yaml',
  HTTP_REQUEST: '.http.yaml',
  GRPC_REQUEST: '.grpc.yaml',
} as const;

// Schemas for YAML file content validation
const fileKeyValueSchema = z.object({
  key: z.string(),
  value: z.string(),
  enabled: z.boolean().optional(),
  description: z.string().optional(),
});

const fileAuthConfigSchema = z.object({
  type: z.enum(['none', 'basic', 'bearer', 'api-key', 'oauth2', 'digest', 'aws-signature']),
  basic: z.object({ username: z.string(), password: z.string() }).optional(),
  bearer: z.object({ token: z.string() }).optional(),
  apiKey: z.object({ key: z.string(), value: z.string(), in: z.enum(['header', 'query']) }).optional(),
  oauth2: z.object({ accessToken: z.string(), tokenType: z.string().optional() }).optional(),
  digest: z.object({ username: z.string(), password: z.string() }).optional(),
  awsSignature: z
    .object({ accessKey: z.string(), secretKey: z.string(), region: z.string(), service: z.string() })
    .optional(),
});

const fileCollectionMetaSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  auth: fileAuthConfigSchema.optional(),
  variables: z.array(fileKeyValueSchema).optional(),
});

const fileFolderMetaSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

// Track active file watchers
const activeWatchers = new Map<string, FSWatcher>();

// Track file modification times for conflict detection
const fileModTimes = new Map<string, number>();

// Generate unique ID
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

// Add ID to key-value items
function addIdsToKeyValues(items?: Array<{ key: string; value: string; enabled?: boolean; description?: string }>) {
  if (!items) return [];
  return items.map((item) => ({
    id: generateId(),
    key: item.key,
    value: item.value,
    enabled: item.enabled ?? true,
    description: item.description,
  }));
}

// Strip IDs from key-value items for file storage
function stripIdsFromKeyValues(items?: Array<{ id: string; key: string; value: string; enabled?: boolean; description?: string }>) {
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
function loadYamlFile(filePath: string): unknown {
  const content = fs.readFileSync(filePath, 'utf-8');
  return yaml.load(content);
}

// Save a YAML file
function saveYamlFile(filePath: string, data: unknown): void {
  const content = yaml.dump(data, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });
  fs.writeFileSync(filePath, content, 'utf-8');
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

    if (!fs.existsSync(directoryPath) || !fs.statSync(directoryPath).isDirectory()) {
      return { success: false, error: 'Directory does not exist' };
    }

    // Load collection metadata
    const metaPath = path.join(directoryPath, FILE_EXTENSIONS.COLLECTION_META);
    if (!fs.existsSync(metaPath)) {
      return { success: false, error: 'No _collection.yaml found in directory' };
    }

    const metaData = loadYamlFile(metaPath);
    const meta = fileCollectionMetaSchema.parse(metaData);

    // Track file mod time
    fileModTimes.set(metaPath, fs.statSync(metaPath).mtimeMs);

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

// Load items from a directory (recursive)
async function loadDirectoryItems(directoryPath: string): Promise<unknown[]> {
  const items: unknown[] = [];
  const entries = fs.readdirSync(directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      // Load folder
      const folderMetaPath = path.join(entryPath, FILE_EXTENSIONS.FOLDER_META);
      let folderName = entry.name;
      let folderDescription: string | undefined;

      if (fs.existsSync(folderMetaPath)) {
        try {
          const folderMeta = fileFolderMetaSchema.parse(loadYamlFile(folderMetaPath));
          folderName = folderMeta.name;
          folderDescription = folderMeta.description;
          fileModTimes.set(folderMetaPath, fs.statSync(folderMetaPath).mtimeMs);
        } catch {
          // Use directory name if meta is invalid
        }
      }

      const folderItems = await loadDirectoryItems(entryPath);

      items.push({
        id: generateId(),
        name: folderName,
        type: 'folder',
        items: folderItems,
        description: folderDescription,
        _filePath: entryPath,
      });
    } else if (entry.isFile()) {
      const requestType = getRequestTypeFromFilename(entry.name);
      if (requestType) {
        try {
          const requestData = loadYamlFile(entryPath) as Record<string, unknown>;
          fileModTimes.set(entryPath, fs.statSync(entryPath).mtimeMs);

          // Build request object with IDs
          const request = {
            id: generateId(),
            type: requestType,
            ...requestData,
            headers: addIdsToKeyValues(requestData.headers as any),
            params: addIdsToKeyValues(requestData.params as any),
            metadata: addIdsToKeyValues(requestData.metadata as any),
          };

          items.push({
            id: generateId(),
            name: requestData.name || entry.name,
            type: 'request',
            request,
            _filePath: entryPath,
          });
        } catch (error) {
          console.error(`Failed to load request file ${entryPath}:`, error);
        }
      }
    }
  }

  return items;
}

// Save collection to directory
async function saveCollectionToDirectory(
  collection: any,
  directoryPath: string
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isPathSafe(directoryPath)) {
      return { success: false, error: 'Access denied: Path is outside allowed directories' };
    }

    // Create directory if it doesn't exist
    if (!fs.existsSync(directoryPath)) {
      fs.mkdirSync(directoryPath, { recursive: true });
    }

    // Save collection metadata
    const meta = {
      name: collection.name,
      ...(collection.description ? { description: collection.description } : {}),
      ...(collection.auth ? { auth: collection.auth } : {}),
      ...(collection.variables?.length ? { variables: stripIdsFromKeyValues(collection.variables) } : {}),
    };

    saveYamlFile(path.join(directoryPath, FILE_EXTENSIONS.COLLECTION_META), meta);

    // Save items recursively
    await saveDirectoryItems(collection.items, directoryPath);

    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

// Save items to directory (recursive)
async function saveDirectoryItems(items: any[], directoryPath: string): Promise<void> {
  for (const item of items) {
    if (item.type === 'folder') {
      const folderPath = path.join(directoryPath, sanitizeFilename(item.name));
      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
      }

      // Save folder metadata
      const folderMeta = {
        name: item.name,
        ...(item.description ? { description: item.description } : {}),
      };
      saveYamlFile(path.join(folderPath, FILE_EXTENSIONS.FOLDER_META), folderMeta);

      // Save nested items
      if (item.items?.length) {
        await saveDirectoryItems(item.items, folderPath);
      }
    } else if (item.type === 'request' && item.request) {
      const req = item.request;
      const extension = req.type === 'grpc' ? FILE_EXTENSIONS.GRPC_REQUEST : FILE_EXTENSIONS.HTTP_REQUEST;
      const filename = `${sanitizeFilename(item.name)}${extension}`;
      const filePath = path.join(directoryPath, filename);

      // Strip IDs and type field for file storage
      const { id, type, ...requestData } = req;
      const fileData = {
        ...requestData,
        headers: stripIdsFromKeyValues(requestData.headers),
        params: stripIdsFromKeyValues(requestData.params),
        metadata: stripIdsFromKeyValues(requestData.metadata),
      };

      // Clean undefined fields
      Object.keys(fileData).forEach((key) => {
        if (fileData[key] === undefined) {
          delete fileData[key];
        }
      });

      saveYamlFile(filePath, fileData);
    }
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
        const mainWindow = getMainWindow();
        if (mainWindow) {
          const lastMod = fileModTimes.get(filePath);
          const currentMod = fs.statSync(filePath).mtimeMs;

          if (lastMod && currentMod > lastMod) {
            // File was modified externally - potential conflict
            mainWindow.webContents.send('collection:file-changed', {
              type: 'modified',
              filePath,
              directoryPath,
              lastModified: currentMod,
            });
          }

          fileModTimes.set(filePath, currentMod);
        }
      })
      .on('add', (filePath) => {
        const mainWindow = getMainWindow();
        if (mainWindow) {
          mainWindow.webContents.send('collection:file-changed', {
            type: 'added',
            filePath,
            directoryPath,
          });
        }
      })
      .on('unlink', (filePath) => {
        const mainWindow = getMainWindow();
        if (mainWindow) {
          mainWindow.webContents.send('collection:file-changed', {
            type: 'deleted',
            filePath,
            directoryPath,
          });
          fileModTimes.delete(filePath);
        }
      })
      .on('error', (error) => {
        console.error('File watcher error:', error);
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
  return { success: true };
}

// IPC validation schemas
const CollectionDataSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  items: z.array(z.any()),
  auth: z.any().optional(),
  variables: z.array(z.any()).optional(),
});

const SaveCollectionSchema = z.tuple([CollectionDataSchema, FilePathSchema]);

// Register IPC handlers
export function registerCollectionManagerIPC(getMainWindow: () => BrowserWindow | null): void {
  // Load collection from directory
  ipcMain.handle(
    'collection:load-directory',
    createValidatedHandler('collection:load-directory', FilePathSchema, async (directoryPath: string) => {
      return loadCollectionFromDirectory(directoryPath);
    })
  );

  // Save collection to directory
  ipcMain.handle(
    'collection:save-directory',
    createValidatedHandler(
      'collection:save-directory',
      SaveCollectionSchema,
      async ([collection, directoryPath]: [any, string]) => {
        return saveCollectionToDirectory(collection, directoryPath);
      }
    )
  );

  // Start watching directory
  ipcMain.handle(
    'collection:watch',
    createValidatedHandler('collection:watch', FilePathSchema, (directoryPath: string) => {
      return watchCollectionDirectory(directoryPath, getMainWindow);
    })
  );

  // Stop watching directory
  ipcMain.handle(
    'collection:unwatch',
    createValidatedHandler('collection:unwatch', FilePathSchema, (directoryPath: string) => {
      return unwatchCollectionDirectory(directoryPath);
    })
  );

  // Open directory in file manager
  ipcMain.handle(
    'collection:open-in-explorer',
    createValidatedHandler('collection:open-in-explorer', FilePathSchema, async (directoryPath: string) => {
      if (!isPathSafe(directoryPath)) {
        return { success: false, error: 'Access denied' };
      }
      await shell.openPath(directoryPath);
      return { success: true };
    })
  );

  // Select directory dialog
  ipcMain.handle('collection:select-directory', async () => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return { canceled: true };

    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Collection Directory',
    });

    return result;
  });

  // Get file info for conflict detection
  ipcMain.handle(
    'collection:get-file-info',
    createValidatedHandler('collection:get-file-info', FilePathSchema, (filePath: string) => {
      try {
        if (!fs.existsSync(filePath)) {
          return { exists: false };
        }
        const stats = fs.statSync(filePath);
        return {
          exists: true,
          lastModified: stats.mtimeMs,
          size: stats.size,
        };
      } catch {
        return { exists: false };
      }
    })
  );
}

// Cleanup on app quit
export function cleanupCollectionWatchers(): void {
  for (const watcher of activeWatchers.values()) {
    watcher.close();
  }
  activeWatchers.clear();
  fileModTimes.clear();
}
