import { constants as fsConstants, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { BrowserWindow } from 'electron';
import { app, dialog, ipcMain, shell } from 'electron';
import { IPC } from '../../shared/channels';
import {
  AppPathNameSchema,
  createValidatedHandler,
  DialogOptionsSchema,
  FsPathSchema,
  NoInputSchema,
  ShellUrlSchema,
  WriteFileSchema,
} from '../ipc/ipc-validators';
import { isMainOwnedUserDataFile } from './userdata-guard';

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
  // Database client credentials
  '.pgpass',
  '.pg_service.conf',
  '.my.cnf',
  '.mylogin.cnf',
  // Build / package-manager credentials (settings.xml, gradle.properties,
  // auth.json, credentials all live under these and routinely hold tokens)
  '.m2',
  '.gradle',
  '.composer',
  '.gem',
  '.bundle',
  '.subversion',
  '.config/rclone',
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
  '.zprofile',
  '.zlogin',
  '.zlogout',
  '.bash_login',
  '.bash_logout',
  '.inputrc',
  '.cshrc',
  '.tcshrc',
  '.kshrc',
  '.xprofile',
  '.xsessionrc',
  '.xsession',
  '.xinitrc',
  '.config/fish',
  // Login-time launchers / autostart (a write here is code execution at next login)
  'Library/LaunchAgents',
  'Library/LaunchDaemons',
  '.config/autostart',
  '.config/systemd',
  '.config/environment.d',
  '.config/plasma-workspace',
  '.local/share/applications',
  '.local/share/systemd',
  // macOS
  'Library/Application Support',
  'Library/Keychains',
  'Library/Cookies',
  'Library/Containers',
  'Library/Group Containers',
  'Library/Messages',
  'Library/Safari',
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

// Pre-split once at module load — isPathSafe runs on every fs read/write and
// the entries never change, so there's no reason to re-split per call.
// Compared case-insensitively: macOS/Windows volumes are case-insensitive by
// default, so `~/.ZProfile` and `~/library/launchagents` name the same files.
// NFKC + lowercase so compatibility forms (e.g. U+017F "ſ" folds to "s" on
// case-insensitive APFS/NTFS) cannot dodge the denylist.
function foldSegment(s: string): string {
  return s.normalize('NFKC').toLowerCase();
}

const HOME_BLOCKED_SUBDIR_PARTS: string[][] = HOME_BLOCKED_SUBDIRS.map((b) =>
  foldSegment(b).split('/')
);

/** True when `resolved` (absolute) sits at/under a denylisted location of `homePath`. */
function isUnderHomeBlocked(resolved: string, homePath: string): boolean {
  if (resolved !== homePath && !resolved.startsWith(homePath + path.sep)) return false;
  const rel = path.relative(homePath, resolved);
  if (rel === '') return false;
  const parts = foldSegment(rel).split(path.sep);
  return HOME_BLOCKED_SUBDIR_PARTS.some(
    (blockedParts) =>
      blockedParts.length <= parts.length && blockedParts.every((p, i) => parts[i] === p)
  );
}

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

/** True when `resolved` is `root` or sits beneath it (separator-bounded). */
function isWithin(resolved: string, root: string): boolean {
  return resolved === root || resolved.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** Separator-bounded, case-insensitive match against the system-root denylist. */
function isBlockedRoot(resolved: string): boolean {
  const r = resolved.toLowerCase();
  return BLOCKED_ROOT_PATHS.some((blocked) => {
    const b = blocked.toLowerCase();
    const sep = b.includes('\\') ? '\\' : '/';
    return r === b || r.startsWith(b + sep);
  });
}

// ---------------------------------------------------------------------------
// Dialog-granted roots. A collection folder the user picks through the native
// directory dialog (IPC.collection.selectDirectory) becomes an allowed root,
// in-memory and persisted in a main-owned file (`restura-*.json` at the userData
// root, which isPathSafe already hides from the renderer). The renderer has no
// channel that adds a root — only the main-process dialog handler calls
// grantCollectionRoot — so a compromised renderer cannot widen the allowlist.
// ---------------------------------------------------------------------------
const GRANTED_ROOTS_FILE = 'restura-collection-roots.json';
let grantedRoots: Set<string> | null = null;

function grantedRootsFile(): string {
  return path.join(app.getPath('userData'), GRANTED_ROOTS_FILE);
}

function getGrantedRoots(): Set<string> {
  if (grantedRoots) return grantedRoots;
  const roots = new Set<string>();
  try {
    const parsed = JSON.parse(readFileSync(grantedRootsFile(), 'utf8')) as { roots?: unknown };
    if (Array.isArray(parsed.roots)) {
      for (const r of parsed.roots) {
        // Re-validate on load: the file is plain JSON on disk.
        if (typeof r === 'string' && path.isAbsolute(r) && isGrantableRoot(r)) roots.add(r);
      }
    }
  } catch {
    // missing / corrupt → no granted roots
  }
  grantedRoots = roots;
  return roots;
}

function persistGrantedRoots(roots: Set<string>): void {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(grantedRootsFile(), JSON.stringify({ version: 1, roots: [...roots] }, null, 2));
  } catch {
    // best-effort: the in-memory grant still applies for this session
  }
}

function isGrantableRoot(resolved: string): boolean {
  if (isBlockedRoot(resolved)) return false;
  if (path.parse(resolved).root === resolved) return false; // filesystem root
  try {
    const homePath = path.resolve(app.getPath('home'));
    if (isUnderHomeBlocked(resolved, homePath)) return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * Record a directory the user picked in the native dialog as an allowed root.
 * Returns false (and records nothing) for system roots, credential folders
 * under $HOME, or paths that are not directories.
 */
export async function grantCollectionRoot(directoryPath: string): Promise<boolean> {
  try {
    const real = await fsp.realpath(path.resolve(directoryPath));
    if (!(await fsp.stat(real)).isDirectory()) return false;
    if (!isGrantableRoot(real)) return false;
    const roots = getGrantedRoots();
    // Keep the path the dialog returned as well as its realpath: the renderer
    // echoes the lexical form back, and isPathRealSafe re-resolves symlinks.
    const lexical = path.resolve(directoryPath);
    const before = roots.size;
    roots.add(real);
    if (isGrantableRoot(lexical)) roots.add(lexical);
    if (roots.size !== before) persistGrantedRoots(roots);
    return true;
  } catch {
    return false;
  }
}

/** Test hook: drop in-memory grants so the next lookup reloads from disk. */
export function resetGrantedCollectionRootsForTests(): void {
  grantedRoots = null;
}

function allowedRoots(): string[] {
  return [
    path.resolve(app.getPath('userData')),
    path.resolve(app.getPath('documents')),
    path.resolve(app.getPath('home')),
    ...getGrantedRoots(),
  ];
}

// Security: Validate file path to prevent path traversal attacks
export function isPathSafe(filePath: string): boolean {
  try {
    const resolved = path.resolve(filePath);
    const userDataPath = path.resolve(app.getPath('userData'));
    const homePath = path.resolve(app.getPath('home'));

    // Cheap denylist for system roots. Paths under the user's own $HOME are
    // exempt from this check (HOME may legitimately be /root); credential
    // folders there are covered by the home denylist below.
    const insideHome = homePath !== path.parse(homePath).root && isWithin(resolved, homePath);
    if (!insideHome && isBlockedRoot(resolved)) return false;

    // Must sit under an allowed root, with path-sep guard against prefix-collision
    if (!allowedRoots().some((root) => isWithin(resolved, root))) return false;

    // Main-owned state lives directly in userData: electron-store files
    // (`restura-*.json` — secret handles, stdio consent, vault, …) and key
    // blobs (dotfiles). The renderer-facing fs channels must never read or
    // overwrite them, or a compromised renderer could forge main's own
    // decisions. Subdirectories (e.g. userData/collections) stay reachable.
    // Compared on a canonical form (realpath, Win32 name aliases, case).
    if (isMainOwnedUserDataFile(resolved, userDataPath)) return false;

    // $HOME-specific denylist. userData is explicitly allowed even when it
    // sits under a denylisted home subdir (macOS ~/Library/Application Support).
    if (!isWithin(resolved, userDataPath) && isUnderHomeBlocked(resolved, homePath)) return false;

    return true;
  } catch {
    return false;
  }
}

/** Return the lexical allowlist root that authorized a path. */
export function getAllowedRootForPath(filePath: string): string | null {
  if (!isPathSafe(filePath)) return null;
  const resolved = path.resolve(filePath);
  return allowedRoots().find((root) => isWithin(resolved, root)) ?? null;
}

/**
 * Re-check an allowed path after resolving symlinks. For a path that does not
 * exist yet, resolve its nearest existing ancestor and append the missing
 * suffix. This closes the gap where a lexical child points outside its root.
 */
export async function isPathRealSafe(filePath: string): Promise<boolean> {
  const allowedRoot = getAllowedRootForPath(filePath);
  if (!allowedRoot) return false;
  try {
    const [realRoot, realTarget] = await Promise.all([
      fsp.realpath(allowedRoot),
      resolveFromExistingAncestor(path.resolve(filePath)),
    ]);
    if (!(realTarget === realRoot || realTarget.startsWith(realRoot + path.sep))) return false;
    // A dialog-granted root is trusted for where it pointed when granted; if it
    // is a symlink later retargeted at a system path, refuse it now.
    if (getGrantedRoots().has(allowedRoot) && !isGrantableRoot(realRoot)) return false;
    // A symlink may land inside $HOME's denylist (shell init, autostart, creds)
    // even though its lexical path looked fine — re-apply the denylist to the
    // real target against the real home.
    const homePath = path.resolve(app.getPath('home'));
    const realHome = await fsp.realpath(homePath).catch(() => homePath);
    const userDataPath = path.resolve(app.getPath('userData'));
    const realUserData = await fsp.realpath(userDataPath).catch(() => userDataPath);
    if (!isWithin(realTarget, realUserData) && isUnderHomeBlocked(realTarget, realHome)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Windows-only name tricks that alias a denylisted entry on NTFS: trailing
 * dot/space components and alternate data streams (':' after the drive).
 */
export function hasUnsafeWin32Components(filePath: string): boolean {
  const rest = filePath.replace(/^[A-Za-z]:/, '').replace(/^[\\/]{2}[?.][\\/]([A-Za-z]:)?/, '');
  if (rest.includes(':')) return true;
  return rest.split(/[\\/]/).some((c) => c !== '' && c !== '.' && /[. ]$/.test(c));
}

/** Absolute, no `..` segments (the kernel resolves `..` after following symlinks). */
export function isCanonicalInputPath(filePath: string): boolean {
  if (!path.isAbsolute(filePath) || filePath.includes('\0')) return false;
  if (filePath.split(/[\\/]/).includes('..')) return false;
  if (process.platform === 'win32' && hasUnsafeWin32Components(filePath)) return false;
  return true;
}

/**
 * Validate a renderer-supplied path and return the canonical real target that
 * was checked (callers must operate on this, never re-resolve the raw input).
 */
export async function resolveCheckedPath(filePath: string): Promise<string | null> {
  if (!isCanonicalInputPath(filePath)) return null;
  if (!isPathSafe(filePath) || !(await isPathRealSafe(filePath))) return null;
  try {
    return await resolveFromExistingAncestor(path.resolve(filePath));
  } catch {
    return null;
  }
}

async function resolveFromExistingAncestor(target: string): Promise<string> {
  const missing: string[] = [];
  let current = target;
  while (true) {
    try {
      const real = await fsp.realpath(current);
      return path.resolve(real, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export function registerFileOperationsIPC(getMainWindow: () => BrowserWindow | null): void {
  // Dialog handlers
  ipcMain.handle(
    IPC.dialog.openFile,
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
    IPC.dialog.saveFile,
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
    IPC.fs.readFile,
    createValidatedHandler(IPC.fs.readFile, FsPathSchema, async (filePath: string) => {
      try {
        const target = await resolveCheckedPath(filePath);
        if (!target) {
          return { success: false, error: 'Access denied: Path is outside allowed directories' };
        }

        const stats = await fsp.stat(target);
        if (stats.size > MAX_FILE_SIZE_BYTES) {
          return {
            success: false,
            error: `File too large: Maximum size is ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB`,
          };
        }

        const content = await fsp.readFile(target, 'utf-8');
        return { success: true, content };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    })
  );

  ipcMain.handle(
    IPC.fs.writeFile,
    createValidatedHandler(
      IPC.fs.writeFile,
      WriteFileSchema,
      async ([filePath, content]: [string, string]) => {
        try {
          const target = await resolveCheckedPath(filePath);
          if (!target) {
            return { success: false, error: 'Access denied: Path is outside allowed directories' };
          }

          if (content.length > MAX_FILE_SIZE_BYTES) {
            return {
              success: false,
              error: `Content too large: Maximum size is ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB`,
            };
          }

          // Write the canonical target we validated, refusing a final-component
          // symlink (O_NOFOLLOW is unavailable on Windows).
          const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
          const handle = await fsp.open(
            target,
            fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | noFollow,
            0o600
          );
          try {
            await handle.writeFile(content, 'utf-8');
          } finally {
            await handle.close();
          }
          return { success: true };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      }
    )
  );

  // App info handlers
  ipcMain.handle(
    IPC.app.getPath,
    createValidatedHandler(IPC.app.getPath, AppPathNameSchema, (name) => {
      return app.getPath(name as Parameters<typeof app.getPath>[0]);
    })
  );

  ipcMain.handle(
    IPC.app.getVersion,
    createValidatedHandler(IPC.app.getVersion, NoInputSchema, () => {
      return app.getVersion();
    })
  );

  ipcMain.handle(
    IPC.shell.openExternal,
    createValidatedHandler(IPC.shell.openExternal, ShellUrlSchema, async (url: string) => {
      await shell.openExternal(url);
    })
  );
}
