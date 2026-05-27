import type { BrowserWindow } from 'electron';
import { app, ipcMain, dialog, shell } from 'electron';
import * as fsp from 'fs/promises';
import * as path from 'path';
import {
  DialogOptionsSchema,
  FilePathSchema,
  WriteFileSchema,
  AppPathNameSchema,
  ShellUrlSchema,
  createValidatedHandler,
  NoInputSchema,
} from './ipc-validators';
import { IPC } from '../shared/channels';

// Security: Maximum file size to prevent memory exhaustion
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

// Subdirectories under $HOME that hold credentials / browser data / package
// secrets — never reachable through fs:readFile / fs:writeFile, even though
// we still allow $HOME for the rare legitimate user-picked path. Each entry
// is matched as a leading path component sequence.
const HOME_BLOCKED_SUBDIRS = [
  // SSH / cloud / VCS / package credentials
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker',
  '.npmrc',
  '.netrc',
  '.password-store',
  '.config/gh',
  '.config/op',
  '.config/gcloud',
  '.config/git',
  '.gitconfig',
  '.git-credentials',
  '.yarnrc',
  '.yarnrc.yml',
  '.pypirc',
  '.cargo/credentials',
  '.cargo/credentials.toml',
  '.terraformrc',
  '.terraform.d/credentials.tfrc.json',
  '.vault-token',
  '.azure',
  '.databricks',
  // Shell history files (commonly leak pasted tokens/passwords)
  '.bash_history',
  '.zsh_history',
  '.psql_history',
  '.mysql_history',
  '.node_repl_history',
  '.python_history',
  '.lesshst',
  // Shell init files (often contain export X=token)
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zshenv',
  '.profile',
  // macOS
  'Library/Application Support',
  'Library/Keychains',
  'Library/Cookies',
  // Windows
  'AppData/Roaming/Microsoft',
  'AppData/Local/Google',
  'AppData/Local/Microsoft',
  'AppData/Local/BraveSoftware',
  // Linux / freedesktop
  '.config/google-chrome',
  '.config/chromium',
  '.config/BraveSoftware',
  '.config/microsoft-edge',
  '.config/Microsoft',
  '.local/share/keyrings',
  '.mozilla',
  'snap/firefox/common/.mozilla',
];

// Block access to sensitive system directories at the OS level (cheap
// defense-in-depth — userData/documents/home are inside the user's profile
// so these shouldn't be reachable anyway, but a misconfigured app.getPath()
// could return a system path).
const BLOCKED_ROOT_PATHS = [
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

// Security: Validate file path to prevent path traversal attacks
export function isPathSafe(filePath: string): boolean {
  try {
    const resolved = path.resolve(filePath);
    const userDataPath = path.resolve(app.getPath('userData'));
    const documentsPath = path.resolve(app.getPath('documents'));
    const homePath = path.resolve(app.getPath('home'));

    // Cheap denylist for system roots
    for (const blocked of BLOCKED_ROOT_PATHS) {
      if (resolved.toLowerCase().startsWith(blocked.toLowerCase())) {
        return false;
      }
    }

    // Must sit under an allowed root, with path-sep guard against prefix-collision
    const allowedRoots = [userDataPath, documentsPath, homePath];
    const underAllowed = allowedRoots.some(
      (root) => resolved === root || resolved.startsWith(root + path.sep)
    );
    if (!underAllowed) return false;

    // $HOME-specific denylist
    if (resolved === homePath || resolved.startsWith(homePath + path.sep)) {
      const rel = path.relative(homePath, resolved);
      // rel may be '' (the home root itself — allowed) or 'foo/bar/...'
      if (rel === '') return true;
      const parts = rel.split(path.sep);
      for (const blocked of HOME_BLOCKED_SUBDIRS) {
        const blockedParts = blocked.split('/');
        if (blockedParts.length > parts.length) continue;
        if (blockedParts.every((p, i) => parts[i] === p)) return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

export function registerFileOperationsIPC(getMainWindow: () => BrowserWindow | null): void {
  // Dialog handlers
  ipcMain.handle(
    'dialog:openFile',
    createValidatedHandler(IPC.dialog.openFile, DialogOptionsSchema.optional(), async (options) => {
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
    createValidatedHandler(IPC.dialog.saveFile, DialogOptionsSchema.optional(), async (options) => {
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

  // File system handlers (async fs so the main thread stays responsive when
  // import/export touches a 50 MB collection).
  ipcMain.handle(
    'fs:readFile',
    createValidatedHandler(IPC.fs.readFile, FilePathSchema, async (filePath: string) => {
      try {
        if (!isPathSafe(filePath)) {
          return { success: false, error: 'Access denied: Path is outside allowed directories' };
        }

        const stats = await fsp.stat(filePath);
        if (stats.size > MAX_FILE_SIZE_BYTES) {
          return { success: false, error: `File too large: Maximum size is ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB` };
        }

        const content = await fsp.readFile(filePath, 'utf-8');
        return { success: true, content };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    })
  );

  ipcMain.handle(
    'fs:writeFile',
    createValidatedHandler(IPC.fs.writeFile, WriteFileSchema, async ([filePath, content]: [string, string]) => {
      try {
        if (!isPathSafe(filePath)) {
          return { success: false, error: 'Access denied: Path is outside allowed directories' };
        }

        if (content.length > MAX_FILE_SIZE_BYTES) {
          return { success: false, error: `Content too large: Maximum size is ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB` };
        }

        await fsp.writeFile(filePath, content, 'utf-8');
        return { success: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    })
  );

  // App info handlers
  ipcMain.handle(
    'app:getPath',
    createValidatedHandler(IPC.app.getPath, AppPathNameSchema, (name) => {
      return app.getPath(name as Parameters<typeof app.getPath>[0]);
    })
  );

  ipcMain.handle(
    'app:getVersion',
    createValidatedHandler(IPC.app.getVersion, NoInputSchema, () => {
      return app.getVersion();
    })
  );

  ipcMain.handle(
    'shell:openExternal',
    createValidatedHandler(IPC.shell.openExternal, ShellUrlSchema, async (url: string) => {
      await shell.openExternal(url);
    })
  );
}
