import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { loadCollectionFromDir } from './fs-reader';
import type { OpenCollection } from './schemas';
import { serializeOpenCollectionYAML } from './serializer';

const MANIFEST_FILE = '.restura-managed-files.json';

/**
 * Write a bundled OpenCollection YAML file.
 *
 * **Caller MUST validate that `path` is in an allowed directory.** This
 * function does no path-traversal checking. See `electron/main/storage/file-operations.ts:isPathSafe`.
 */
export async function saveCollectionToFile(oc: OpenCollection, path: string): Promise<void> {
  const compacted = (compact(oc) ?? {}) as Record<string, unknown>;
  const yaml = serializeOpenCollectionYAML({ ...compacted, bundled: true } as OpenCollection);
  await writeFile(path, yaml, 'utf8');
}

/**
 * Write a directory-layout OpenCollection: emits `opencollection.yml` at
 * `dir`, then one subdirectory per folder (with optional `_folder.yaml`)
 * and one `.yaml` file per request.
 *
 * **Caller MUST validate that `dir` is in an allowed directory.** This
 * function will create subdirectories and files freely under `dir`. See
 * `electron/main/storage/file-operations.ts:isPathSafe`.
 */
export async function saveCollectionToDir(oc: OpenCollection, dir: string): Promise<void> {
  await assertNotSymlink(dir);
  await mkdir(dir, { recursive: true });
  const staging = await mkdtemp(join(dirname(resolve(dir)), '.restura-stage-'));
  try {
    await writeCollectionLayout(oc, staging);
    // Refuse to touch the destination unless the complete staged document can
    // be parsed back through the same schema used on load.
    await loadCollectionFromDir(staging);
    await reconcileManagedFiles(staging, resolve(dir));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function writeCollectionLayout(oc: OpenCollection, dir: string): Promise<void> {
  const { items, ...rootRest } = oc;
  // Root file holds metadata + config; items live as nested files
  const root = (compact({ ...rootRest, bundled: false }) ?? {}) as Record<string, unknown>;
  await writeFile(
    join(dir, 'opencollection.yml'),
    serializeOpenCollectionYAML(root as OpenCollection),
    'utf8'
  );
  await writeItems((items ?? []) as unknown[], dir);
}

async function reconcileManagedFiles(staging: string, destination: string): Promise<void> {
  const nextFiles = (await listFiles(staging)).filter(isManagedCollectionFile);
  const nextSet = new Set(nextFiles);
  const manifestFiles = await readManifest(destination);
  const previousFiles =
    manifestFiles.length > 0
      ? manifestFiles.filter(isManagedCollectionFile)
      : (await listFiles(destination)).filter(isManagedCollectionFile);

  // Remove only paths Restura recorded as managed on the previous successful
  // save. Unrelated files (README, .git, user fixtures) are never inferred or
  // deleted.
  const stale = previousFiles.filter((file) => !nextSet.has(file));
  const affected = [...new Set([...previousFiles, ...nextFiles, MANIFEST_FILE])];
  const backup = await mkdtemp(join(dirname(destination), '.restura-backup-'));
  const backedUp: string[] = [];

  try {
    // Validate every destination path before mutating anything. This prevents
    // a forged manifest or an intermediate symlink from escaping the root.
    for (const file of affected) await assertNoSymlinkPath(destination, file);

    for (const file of affected) {
      const source = safeManagedPath(destination, file);
      const target = safeManagedPath(backup, file);
      if (!source || !target) throw new Error(`Unsafe managed collection path: ${file}`);
      try {
        if (!(await lstat(source)).isFile()) continue;
        await mkdir(dirname(target), { recursive: true });
        await copyFile(source, target);
        backedUp.push(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }

    try {
      for (const file of stale) {
        const target = safeManagedPath(destination, file);
        if (!target) throw new Error(`Unsafe managed collection path: ${file}`);
        await unlink(target).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }

      for (const file of nextFiles) {
        const source = safeManagedPath(staging, file);
        const target = safeManagedPath(destination, file);
        if (!source || !target) throw new Error(`Unsafe managed collection path: ${file}`);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(source, target);
      }

      const manifestTemp = join(destination, `${MANIFEST_FILE}.tmp`);
      await assertNoSymlinkPath(destination, `${MANIFEST_FILE}.tmp`);
      await writeFile(
        manifestTemp,
        `${JSON.stringify({ version: 1, files: nextFiles }, null, 2)}\n`
      );
      await rename(manifestTemp, join(destination, MANIFEST_FILE));
    } catch (error) {
      // Roll back the complete managed set. Unrelated files are never touched.
      for (const file of affected) {
        const target = safeManagedPath(destination, file);
        if (target) await unlink(target).catch(() => undefined);
      }
      for (const file of backedUp) {
        const source = safeManagedPath(backup, file);
        const target = safeManagedPath(destination, file);
        if (!source || !target) continue;
        await mkdir(dirname(target), { recursive: true });
        await copyFile(source, target);
      }
      throw error;
    }
  } finally {
    await rm(backup, { recursive: true, force: true });
  }

  // Best-effort pruning of directories that became empty after stale files
  // were removed. rmdir deliberately fails when an unrelated file remains.
  const staleDirs = [...new Set(stale.map((file) => dirname(file)).filter((p) => p !== '.'))].sort(
    (a, b) => b.length - a.length
  );
  for (const relDir of staleDirs) {
    const target = safeManagedPath(destination, relDir);
    if (target) await rmdir(target).catch(() => undefined);
  }
}

function isManagedCollectionFile(file: string): boolean {
  const normalized = file.split(sep).join('/');
  if (normalized === 'opencollection.yml' || normalized === 'opencollection.yaml') return true;
  if (normalized.endsWith('/_folder.yml') || normalized.endsWith('/_folder.yaml')) return true;
  return /\.ya?ml$/i.test(normalized) && !normalized.startsWith('.');
}

async function listFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, full)));
    else if (entry.isFile()) files.push(relative(root, full));
  }
  return files.sort();
}

async function readManifest(dir: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, MANIFEST_FILE), 'utf8')) as {
      version?: unknown;
      files?: unknown;
    };
    if (parsed.version !== 1 || !Array.isArray(parsed.files)) return [];
    return parsed.files.filter((file): file is string => typeof file === 'string');
  } catch {
    return [];
  }
}

function safeManagedPath(root: string, relativePath: string): string | null {
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, relativePath);
  return candidate.startsWith(`${resolvedRoot}${sep}`) ? candidate : null;
}

async function assertNotSymlink(target: string): Promise<void> {
  try {
    if ((await lstat(target)).isSymbolicLink()) {
      throw new Error(`Refusing to write collection through symbolic link: ${target}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function assertNoSymlinkPath(root: string, relativePath: string): Promise<void> {
  let current = resolve(root);
  await assertNotSymlink(current);
  for (const segment of relativePath.split(sep).filter(Boolean)) {
    current = join(current, segment);
    await assertNotSymlink(current);
  }
}

async function writeItems(items: unknown[], dir: string): Promise<void> {
  // Track names already used in this directory so two items with similar
  // names ("User", "User !") don't both slug to the same filename and
  // silently overwrite each other.
  const usedSlugs = new Set<string>();

  for (const it of items) {
    const item = it as Record<string, unknown>;
    if (isFolder(item)) {
      const slug = uniqueSlug((item.info as { name: string }).name, usedSlugs);
      const folderDir = join(dir, slug);
      await mkdir(folderDir, { recursive: true });
      const folderMeta = compact({ info: item.info, request: item.request, docs: item.docs });
      if (folderMeta && Object.keys(folderMeta as object).length > 0) {
        await writeFile(
          join(folderDir, '_folder.yaml'),
          serializeOpenCollectionYAML(folderMeta as OpenCollection),
          'utf8'
        );
      }
      await writeItems((item.items as unknown[]) ?? [], folderDir);
    } else {
      const info = item.info as { name: string; type: string };
      const slug = uniqueSlug(info.name, usedSlugs);
      const filename = `${slug}.yaml`;
      await writeFile(
        join(dir, filename),
        serializeOpenCollectionYAML(compact(item) as OpenCollection),
        'utf8'
      );
    }
  }
}

function isFolder(item: Record<string, unknown>): boolean {
  const info = item.info as { type?: string } | undefined;
  return !info?.type && Array.isArray(item.items);
}

/**
 * Convert a human-readable name to a filesystem-safe slug.
 * Collisions ("User" and "User & Me" both → "user") are deduplicated
 * by the caller via {@link uniqueSlug}.
 */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      // NFKD splits accented characters into base letter + combining mark.
      .normalize('NFKD')
      // Strip combining diacritical marks (Unicode block U+0300–U+036F)
      // so e.g. "Café" → "cafe", "Müller" → "muller". The literal range
      // characters are present in the regex source for portability across
      // older minifiers that don't support `\u{...}` escapes.
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'item'
  );
}

/**
 * Produce a slug guaranteed to be unique within `used`. If the base slug
 * is already taken, appends `-2`, `-3`, ... until a free name is found.
 * Mutates `used` to reserve the chosen slug.
 */
function uniqueSlug(name: string, used: Set<string>): string {
  const base = slugify(name);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  const slug = `${base}-${n}`;
  used.add(slug);
  return slug;
}

function compact<T>(obj: T): T | undefined {
  if (Array.isArray(obj)) {
    const out = obj.map((v) => compact(v)).filter((v) => v !== undefined);
    return (out.length === 0 ? undefined : out) as unknown as T;
  }
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const c = compact(v);
      if (c !== undefined && !(Array.isArray(c) && c.length === 0)) {
        out[k] = c;
      }
    }
    return out as T;
  }
  return obj;
}
