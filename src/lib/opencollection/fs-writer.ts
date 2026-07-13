import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
export interface SaveCollectionDirectoryOptions {
  /** Files the caller established as belonging to a loaded OpenCollection layout. */
  previousManagedFiles?: string[];
  /** Lexical allowlist root whose resolved real path must contain the destination. */
  trustedRoot?: string;
  /** Snapshot captured by the caller before staging, used for optimistic concurrency. */
  expectedPreviousFingerprints?: Record<string, string | null>;
  /** Snapshot of the ownership manifest itself; null means it did not exist. */
  expectedManifestFingerprint?: string | null;
  /** @internal Deterministic coordination hook used by transaction tests. */
  beforeMutation?: (relativePath: string) => Promise<void>;
}

export interface SaveCollectionDirectoryResult {
  managedFiles: string[];
  removedFiles: string[];
  /** Hashes of the staged bytes, captured before destination mutation. */
  fingerprints: Record<string, string>;
}

export async function saveCollectionToDir(
  oc: OpenCollection,
  dir: string,
  options: SaveCollectionDirectoryOptions = {}
): Promise<SaveCollectionDirectoryResult> {
  await assertNotSymlink(dir);
  if (options.trustedRoot) await assertWithinRealRoot(dir, options.trustedRoot);
  await mkdir(dir, { recursive: true });
  const staging = await mkdtemp(join(dirname(resolve(dir)), '.restura-stage-'));
  try {
    await writeCollectionLayout(oc, staging);
    // Refuse to touch the destination unless the complete staged document can
    // be parsed back through the same schema used on load.
    await loadCollectionFromDir(staging);
    return await reconcileManagedFiles(
      staging,
      resolve(dir),
      options.previousManagedFiles ?? [],
      options.previousManagedFiles !== undefined,
      options.expectedPreviousFingerprints ?? {},
      options.expectedManifestFingerprint,
      options.beforeMutation
    );
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

async function reconcileManagedFiles(
  staging: string,
  destination: string,
  callerManagedFiles: string[],
  callerOwnershipIsAuthoritative: boolean,
  expectedPreviousFingerprints: Record<string, string | null>,
  expectedManifestFingerprint: string | null | undefined,
  beforeMutation: ((relativePath: string) => Promise<void>) | undefined
): Promise<SaveCollectionDirectoryResult> {
  const nextFiles = (await listFiles(staging)).filter(isManagedCollectionFile);
  const fingerprints = Object.fromEntries(
    await Promise.all(
      nextFiles.map(async (file) => [
        file,
        createHash('sha256')
          .update(await readFile(safeManagedPath(staging, file)!))
          .digest('hex'),
      ])
    )
  );
  const nextSet = new Set(nextFiles);
  const manifestFiles = callerOwnershipIsAuthoritative ? null : await readManifest(destination);
  const previousFiles = (
    callerOwnershipIsAuthoritative ? callerManagedFiles : (manifestFiles ?? [])
  ).filter(isManagedCollectionFile);
  const previousSet = new Set(previousFiles);

  // Remove only paths Restura recorded as managed on the previous successful
  // save. Unrelated files (README, .git, user fixtures) are never inferred or
  // deleted.
  const stale = previousFiles.filter((file) => !nextSet.has(file));
  const affected = [...new Set([...previousFiles, ...nextFiles, MANIFEST_FILE])];
  const backup = await mkdtemp(join(dirname(destination), '.restura-backup-'));
  const backedUp: string[] = [];
  const mutations: Array<{ file: string; writtenFingerprint: string | null }> = [];

  try {
    // Validate every destination path before mutating anything. This prevents
    // a forged manifest or an intermediate symlink from escaping the root.
    for (const file of affected) await assertNoSymlinkPath(destination, file);
    if (expectedManifestFingerprint !== undefined) {
      await assertFingerprintUnchanged(destination, MANIFEST_FILE, expectedManifestFingerprint);
    }
    for (const file of nextFiles) {
      if (!previousSet.has(file)) await assertUnownedTargetAbsent(destination, file);
    }
    for (const file of previousFiles) {
      if (Object.hasOwn(expectedPreviousFingerprints, file)) {
        await assertFingerprintUnchanged(
          destination,
          file,
          expectedPreviousFingerprints[file] ?? null
        );
      }
    }

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
        await beforeMutation?.(file);
        if (Object.hasOwn(expectedPreviousFingerprints, file)) {
          await assertFingerprintUnchanged(
            destination,
            file,
            expectedPreviousFingerprints[file] ?? null
          );
        }
        const target = safeManagedPath(destination, file);
        if (!target) throw new Error(`Unsafe managed collection path: ${file}`);
        await unlink(target).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
        mutations.push({ file, writtenFingerprint: null });
      }

      for (const file of nextFiles) {
        await beforeMutation?.(file);
        if (previousSet.has(file) && Object.hasOwn(expectedPreviousFingerprints, file)) {
          await assertFingerprintUnchanged(
            destination,
            file,
            expectedPreviousFingerprints[file] ?? null
          );
        } else if (!previousSet.has(file)) {
          await assertUnownedTargetAbsent(destination, file);
        }
        const source = safeManagedPath(staging, file);
        const target = safeManagedPath(destination, file);
        if (!source || !target) throw new Error(`Unsafe managed collection path: ${file}`);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(source, target);
        mutations.push({ file, writtenFingerprint: fingerprints[file] ?? null });
      }

      // Build the replacement manifest inside Restura's private backup dir;
      // a predictable temp name in the destination could collide with an
      // unrelated user file.
      const manifestTemp = join(backup, 'next-manifest.json');
      if (expectedManifestFingerprint !== undefined) {
        await assertFingerprintUnchanged(destination, MANIFEST_FILE, expectedManifestFingerprint);
      }
      await writeFile(
        manifestTemp,
        `${JSON.stringify({ version: 1, files: nextFiles }, null, 2)}\n`
      );
      await rename(manifestTemp, join(destination, MANIFEST_FILE));
    } catch (error) {
      // Roll back only paths Restura actually mutated, and only while their
      // current bytes still match what Restura wrote. Concurrent external
      // changes always win and are never replaced with stale backup data.
      for (const mutation of [...mutations].reverse()) {
        if (
          (await fingerprintManagedFile(destination, mutation.file)) !== mutation.writtenFingerprint
        ) {
          continue;
        }
        const file = mutation.file;
        const target = safeManagedPath(destination, file);
        if (target) await unlink(target).catch(() => undefined);
        if (backedUp.includes(file)) {
          const source = safeManagedPath(backup, file);
          if (!source || !target) continue;
          await mkdir(dirname(target), { recursive: true });
          await copyFile(source, target);
        }
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
  return { managedFiles: nextFiles, removedFiles: stale, fingerprints };
}

async function assertUnownedTargetAbsent(root: string, relativePath: string): Promise<void> {
  const target = safeManagedPath(root, relativePath);
  if (!target) throw new Error(`Unsafe managed collection path: ${relativePath}`);
  try {
    await lstat(target);
    throw new Error(`Refusing to overwrite unowned file: ${relativePath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function assertFingerprintUnchanged(
  root: string,
  relativePath: string,
  expected: string | null
): Promise<void> {
  const target = safeManagedPath(root, relativePath);
  if (!target) throw new Error(`Unsafe managed collection path: ${relativePath}`);
  const actual = await fingerprintManagedFile(root, relativePath);
  if (actual !== expected) {
    throw new Error(`Managed collection file changed since it was loaded: ${relativePath}`);
  }
}

async function fingerprintManagedFile(root: string, relativePath: string): Promise<string | null> {
  const target = safeManagedPath(root, relativePath);
  if (!target) return null;
  try {
    return createHash('sha256')
      .update(await readFile(target))
      .digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  }
}

function isManagedCollectionFile(file: string): boolean {
  if (file.length === 0 || isAbsolute(file)) return false;
  const normalized = file.split(/[\\/]/).join('/');
  if (normalized.split('/').some((part) => part === '..')) return false;
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

async function readManifest(dir: string): Promise<string[] | null> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, MANIFEST_FILE), 'utf8')) as {
      version?: unknown;
      files?: unknown;
    };
    if (parsed.version !== 1 || !Array.isArray(parsed.files)) return null;
    return parsed.files.filter((file): file is string => typeof file === 'string');
  } catch {
    return null;
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

async function assertWithinRealRoot(target: string, trustedRoot: string): Promise<void> {
  const realRoot = await realpath(trustedRoot);
  let existing = resolve(target);
  for (;;) {
    try {
      const realExisting = await realpath(existing);
      if (realExisting !== realRoot && !realExisting.startsWith(`${realRoot}${sep}`)) {
        throw new Error(`Refusing to write collection through symbolic link: ${target}`);
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
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
