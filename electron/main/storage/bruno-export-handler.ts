/**
 * Writes a directory export — Bruno `.bru` files and the Postman v3 YAML
 * folder (the flat `{relativePath, content}[]` shape produced by
 * `bruno-exporter.ts` / `postmanV3Export.ts`) — under a user-picked
 * directory. Kept separate from `collection-manager.ts` — that file owns
 * Restura's own `.rq.yaml`/`.grq.yaml` schema; this one owns third-party
 * text formats.
 *
 * The relative paths come from the renderer, so main enforces (#1201):
 *  - every path segment is sanitised (no NUL / control chars, no reserved
 *    Windows names, no `.` / `..` / empty segments);
 *  - lexical containment AND `isPathSafe` (incl. the $HOME denylist) for the
 *    root and for every destination;
 *  - symlinks are never followed: the root, every intermediate directory and
 *    the file itself are `lstat`-checked, real paths are re-checked against
 *    the real root, and files are opened with `O_NOFOLLOW` where available;
 *  - file-count / per-file / total-size caps, checked before anything is
 *    written;
 *  - with `replace`, only files matching the export layout are deleted from
 *    the export folder first (never following symlinks, never anything else).
 */

import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { z } from 'zod';
import { IPC } from '../../shared/channels';
import { createKeyedRateLimiter, rateLimited } from '../ipc/ipc-rate-limiter';
import { createValidatedHandler, FilePathSchema } from '../ipc/ipc-validators';
import { isPathRealSafe, isPathSafe } from './file-operations';

export interface BrunoExportEntry {
  relativePath: string;
  content: string;
}

export const DIRECTORY_EXPORT_LIMITS = {
  maxFiles: 10_000,
  maxEntryBytes: 50 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
  maxRelativePathLength: 4096,
} as const;

export type ExportLayout = 'postman-v3' | 'bruno';

export interface DirectoryExportOptions {
  /** Delete files matching `layout` inside `<directory>/<subdir>` before writing. */
  replace?: { layout: ExportLayout; subdir: string };
}

const BrunoExportEntrySchema = z.object({
  relativePath: z.string().min(1).max(DIRECTORY_EXPORT_LIMITS.maxRelativePathLength),
  content: z.string().max(DIRECTORY_EXPORT_LIMITS.maxEntryBytes),
});

const SegmentSchema = z.string().min(1).max(255);

const DirectoryExportOptionsSchema = z
  .object({
    replace: z
      .object({ layout: z.enum(['postman-v3', 'bruno']), subdir: SegmentSchema })
      .strict()
      .optional(),
  })
  .strict();

const SaveBrunoDirectorySchema = z.union([
  z.tuple([z.array(BrunoExportEntrySchema), FilePathSchema]),
  z.tuple([
    z.array(BrunoExportEntrySchema),
    FilePathSchema,
    DirectoryExportOptionsSchema.optional(),
  ]),
]);

const InspectExportTargetSchema = z.tuple([FilePathSchema, SegmentSchema]);

const CONTROL = /[\u0000-\u001f\u007f]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** Split + validate a renderer-supplied relative path; throws on any unsafe segment. */
export function safeSegments(relativePath: string): string[] {
  if (CONTROL.test(relativePath)) throw new Error('control characters in export path');
  const segments = relativePath.replace(/\\/g, '/').split('/');
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..')
      throw new Error(`invalid path segment in "${relativePath}"`);
    if (WINDOWS_RESERVED.test(s)) throw new Error(`reserved file name "${s}"`);
    if (s.length > 255) throw new Error('path segment too long');
  }
  return segments;
}

function contained(root: string, p: string): boolean {
  return p === root || p.startsWith(root + path.sep);
}

async function lstatOrNull(p: string): Promise<fs.Stats | null> {
  try {
    return await fsp.lstat(p);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** mkdir one level at a time, refusing symlinks / non-directories on the way. */
async function ensureRealDir(dir: string): Promise<void> {
  const st = await lstatOrNull(dir);
  if (st === null) {
    await fsp.mkdir(dir);
    return;
  }
  if (st.isSymbolicLink()) throw new Error(`refusing to follow a symlink: ${path.basename(dir)}`);
  if (!st.isDirectory()) throw new Error(`not a directory: ${path.basename(dir)}`);
}

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

async function writeNoFollow(dest: string, content: string): Promise<void> {
  const st = await lstatOrNull(dest);
  if (st?.isSymbolicLink()) throw new Error(`refusing to follow a symlink: ${path.basename(dest)}`);
  if (st && !st.isFile()) throw new Error(`not a file: ${path.basename(dest)}`);
  if (st && st.nlink > 1)
    throw new Error(`refusing to overwrite a hard-linked file: ${path.basename(dest)}`);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | O_NOFOLLOW;
  const handle = await fsp.open(dest, flags, 0o644);
  try {
    await handle.writeFile(content, 'utf-8');
  } finally {
    await handle.close();
  }
}

const LAYOUT_FILES: Record<ExportLayout, (name: string, parent: string) => boolean> = {
  'postman-v3': (name, parent) =>
    /\.(request|example)\.ya?ml$/i.test(name) ||
    (parent === '.resources' && /^definition\.ya?ml$/i.test(name)),
  bruno: (name) => /\.bru$/i.test(name) || name === 'bruno.json',
};

/** Delete export-layout files under `dir` (no symlink is followed or removed). */
async function removeLayoutFiles(dir: string, layout: ExportLayout, depth = 0): Promise<void> {
  if (depth > 128) return;
  const st = await lstatOrNull(dir);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return;
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await removeLayoutFiles(p, layout, depth + 1);
    else if (entry.isFile() && LAYOUT_FILES[layout](entry.name, path.basename(dir))) {
      await fsp.unlink(p);
    }
  }
}

/**
 * Dry run of the write loop: every existing intermediate directory must be a
 * real directory and every existing destination a plain, single-link file,
 * all inside the real root. Runs before anything is deleted or written so a
 * refusal leaves a previous export untouched.
 */
async function preflight(root: string, planned: Array<{ segments: string[]; dest: string }>) {
  const realRoot = await fsp.realpath(root);
  for (const { segments, dest } of planned) {
    let dir = root;
    for (const seg of segments.slice(0, -1)) {
      dir = path.join(dir, seg);
      const st = await lstatOrNull(dir);
      if (!st) break;
      if (st.isSymbolicLink()) throw new Error(`refusing to follow a symlink: ${seg}`);
      if (!st.isDirectory()) throw new Error(`not a directory: ${seg}`);
    }
    const st = await lstatOrNull(dest);
    if (st?.isSymbolicLink())
      throw new Error(`refusing to follow a symlink: ${path.basename(dest)}`);
    if (st && !st.isFile()) throw new Error(`not a file: ${path.basename(dest)}`);
    if (st && st.nlink > 1) {
      throw new Error(`refusing to overwrite a hard-linked file: ${path.basename(dest)}`);
    }
    if (!(await isPathRealSafe(dest)))
      throw new Error('Access denied: export path resolves outside allowed directories');
  }
  return realRoot;
}

/** `replace.subdir` must be the export's single root segment, a real directory (or absent). */
async function checkReplaceDir(
  root: string,
  subdir: string,
  planned: Array<{ segments: string[] }>
): Promise<string> {
  const [name] = safeSegments(subdir);
  if (!name || name !== subdir) throw new Error('invalid replace folder');
  if (!planned.every((p) => p.segments.length > 1 && p.segments[0] === name)) {
    throw new Error('replace folder must be the export root folder');
  }
  const dir = path.join(root, name);
  const st = await lstatOrNull(dir);
  if (st?.isSymbolicLink()) throw new Error('refusing to follow a symlinked export folder');
  if (st && !st.isDirectory()) throw new Error('export folder is not a directory');
  if (!(await isPathRealSafe(dir)))
    throw new Error('Access denied: export folder resolves outside allowed directories');
  return dir;
}

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf-8');
}

export async function saveBrunoEntriesToDirectory(
  directoryPath: string,
  entries: BrunoExportEntry[],
  options: DirectoryExportOptions = {}
): Promise<{ success: boolean; error?: string }> {
  if (!isPathSafe(directoryPath)) {
    return { success: false, error: 'Access denied: Path is outside allowed directories' };
  }
  const root = path.resolve(directoryPath);

  // Validate everything before touching the disk.
  if (entries.length > DIRECTORY_EXPORT_LIMITS.maxFiles) {
    return {
      success: false,
      error: `Export has too many files (limit ${DIRECTORY_EXPORT_LIMITS.maxFiles})`,
    };
  }
  let total = 0;
  const planned: Array<{ segments: string[]; dest: string; content: string }> = [];
  try {
    for (const entry of entries) {
      total += utf8Bytes(entry.content);
      if (total > DIRECTORY_EXPORT_LIMITS.maxTotalBytes) throw new Error('Export is too large');
      const segments = safeSegments(entry.relativePath);
      const dest = path.resolve(root, ...segments);
      if (!contained(root, dest) || dest === root) {
        throw new Error(`Refusing to write outside target directory: ${entry.relativePath}`);
      }
      if (!isPathSafe(dest)) throw new Error(`Access denied: ${entry.relativePath}`);
      planned.push({ segments, dest, content: entry.content });
    }
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }

  try {
    // The root itself must not be (or sit behind) a symlink out of the allowlist.
    if (!(await isPathRealSafe(root)))
      throw new Error('Access denied: target resolves outside allowed directories');
    const rootStat = await lstatOrNull(root);
    if (rootStat?.isSymbolicLink())
      throw new Error('refusing to follow a symlinked target directory');
    await fsp.mkdir(root, { recursive: true });
    const replaceDir = options.replace
      ? await checkReplaceDir(root, options.replace.subdir, planned)
      : undefined;
    const realRoot = await preflight(root, planned);

    if (options.replace && replaceDir) await removeLayoutFiles(replaceDir, options.replace.layout);

    for (const { segments, dest, content } of planned) {
      let dir = root;
      for (const seg of segments.slice(0, -1)) {
        dir = path.join(dir, seg);
        await ensureRealDir(dir);
      }
      const realParent = await fsp.realpath(dir);
      if (!contained(realRoot, realParent) || !(await isPathRealSafe(dest))) {
        throw new Error('Access denied: export path resolves outside the target directory');
      }
      await writeNoFollow(dest, content);
    }
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
  return { success: true };
}

/** Does `<directory>/<childName>` exist, and does it hold anything? Never follows symlinks. */
export async function inspectExportTarget(
  directoryPath: string,
  childName: string
): Promise<{ exists: boolean; nonEmpty: boolean }> {
  const [name] = safeSegments(childName);
  if (!name || name !== childName) throw new Error('invalid export folder name');
  if (!isPathSafe(directoryPath) || !(await isPathRealSafe(directoryPath))) {
    throw new Error('Access denied: Path is outside allowed directories');
  }
  const target = path.join(path.resolve(directoryPath), name);
  if (!isPathSafe(target) || !(await isPathRealSafe(target))) {
    throw new Error('Access denied: Path is outside allowed directories');
  }
  const st = await lstatOrNull(target);
  if (!st) return { exists: false, nonEmpty: false };
  if (!st.isDirectory()) return { exists: true, nonEmpty: true };
  return { exists: true, nonEmpty: (await fsp.readdir(target)).length > 0 };
}

/** Per-sender budget for the directory-export channels (writes and probes). */
export const directoryExportRateLimiter = createKeyedRateLimiter(60, 60_000);

export function registerBrunoExportHandlerIPC(): void {
  ipcMain.handle(
    IPC.collection.saveBrunoDirectory,
    rateLimited(
      directoryExportRateLimiter,
      createValidatedHandler(
        IPC.collection.saveBrunoDirectory,
        SaveBrunoDirectorySchema,
        ([entries, directoryPath, options]) =>
          saveBrunoEntriesToDirectory(directoryPath, entries, options ?? {})
      )
    )
  );
  ipcMain.handle(
    IPC.collection.inspectExportTarget,
    rateLimited(
      directoryExportRateLimiter,
      createValidatedHandler(
        IPC.collection.inspectExportTarget,
        InspectExportTargetSchema,
        ([directoryPath, childName]) => inspectExportTarget(directoryPath, childName)
      )
    )
  );
}

export function disposeBrunoExportHandlerIPC(): void {
  ipcMain.removeHandler(IPC.collection.saveBrunoDirectory);
  ipcMain.removeHandler(IPC.collection.inspectExportTarget);
}
