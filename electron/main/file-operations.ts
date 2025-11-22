import { app, ipcMain, dialog, shell, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import {
  DialogOptionsSchema,
  FilePathSchema,
  WriteFileSchema,
  AppPathNameSchema,
  ShellUrlSchema,
  createValidatedHandler,
} from './ipc-validators';

// Security: Maximum file size to prevent memory exhaustion
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

// Security: Validate file path to prevent path traversal attacks
export function isPathSafe(filePath: string): boolean {
  try {
    const normalizedPath = path.normalize(filePath);
    const userDataPath = app.getPath('userData');
    const documentsPath = app.getPath('documents');
    const homePath = app.getPath('home');

    // Block obvious path traversal attempts
    if (normalizedPath.includes('..') || normalizedPath.includes('~')) {
      return false;
    }

    // Block access to sensitive system directories
    const blockedPaths = [
      '/etc',
      '/usr',
      '/bin',
      '/sbin',
      '/var',
      '/root',
      '/System',
      '/Library',
      '/Applications',
      'C:\\Windows',
      'C:\\Program Files',
      'C:\\Program Files (x86)',
    ];

    for (const blocked of blockedPaths) {
      if (normalizedPath.toLowerCase().startsWith(blocked.toLowerCase())) {
        return false;
      }
    }

    // Allow access to user data directory, documents, and home directory
    const allowedPaths = [userDataPath, documentsPath, homePath];
    return allowedPaths.some((allowed) => normalizedPath.startsWith(allowed));
  } catch {
    return false;
  }
}

export function registerFileOperationsIPC(getMainWindow: () => BrowserWindow | null): void {
  // Dialog handlers
  ipcMain.handle(
    'dialog:openFile',
    createValidatedHandler('dialog:openFile', DialogOptionsSchema.optional(), async (options) => {
      const mainWindow = getMainWindow();
      if (!mainWindow) return null;
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: options?.filters || [
          { name: 'JSON Files', extensions: ['json'] },
          { name: 'All Files', extensions: ['*'] },
        ],
        ...options,
      });
      return result;
    })
  );

  ipcMain.handle(
    'dialog:saveFile',
    createValidatedHandler('dialog:saveFile', DialogOptionsSchema.optional(), async (options) => {
      const mainWindow = getMainWindow();
      if (!mainWindow) return null;
      const result = await dialog.showSaveDialog(mainWindow, {
        filters: options?.filters || [
          { name: 'JSON Files', extensions: ['json'] },
          { name: 'All Files', extensions: ['*'] },
        ],
        ...options,
      });
      return result;
    })
  );

  // File system handlers
  ipcMain.handle(
    'fs:readFile',
    createValidatedHandler('fs:readFile', FilePathSchema, async (filePath: string) => {
      try {
        if (!isPathSafe(filePath)) {
          return { success: false, error: 'Access denied: Path is outside allowed directories' };
        }

        const stats = fs.statSync(filePath);
        if (stats.size > MAX_FILE_SIZE_BYTES) {
          return { success: false, error: `File too large: Maximum size is ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB` };
        }

        const content = fs.readFileSync(filePath, 'utf-8');
        return { success: true, content };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    })
  );

  ipcMain.handle(
    'fs:writeFile',
    createValidatedHandler('fs:writeFile', WriteFileSchema, async ([filePath, content]: [string, string]) => {
      try {
        if (!isPathSafe(filePath)) {
          return { success: false, error: 'Access denied: Path is outside allowed directories' };
        }

        if (content.length > MAX_FILE_SIZE_BYTES) {
          return { success: false, error: `Content too large: Maximum size is ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB` };
        }

        fs.writeFileSync(filePath, content, 'utf-8');
        return { success: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    })
  );

  // App info handlers
  ipcMain.handle(
    'app:getPath',
    createValidatedHandler('app:getPath', AppPathNameSchema, (name) => {
      return app.getPath(name as Parameters<typeof app.getPath>[0]);
    })
  );

  ipcMain.handle('app:getVersion', () => {
    return app.getVersion();
  });

  ipcMain.handle(
    'shell:openExternal',
    createValidatedHandler('shell:openExternal', ShellUrlSchema, async (url: string) => {
      await shell.openExternal(url);
    })
  );
}
