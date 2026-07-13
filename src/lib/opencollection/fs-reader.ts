import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, basename, relative, sep } from 'node:path';
import * as yaml from 'js-yaml';
import {
  assertBoundedDocument,
  folderSchema,
  graphqlRequestSchema,
  grpcRequestSchema,
  httpRequestSchema,
  openCollectionSchema,
  websocketRequestSchema,
} from './schemas';
import type { OpenCollection } from './schemas';
import { parseOpenCollectionYAML, serializeOpenCollectionYAML } from './serializer';

const ROOT_FILES = ['opencollection.yml', 'opencollection.yaml'];
const FOLDER_META = '_folder.yaml';

/**
 * Load a bundled OpenCollection YAML file from disk and validate it.
 *
 * **Caller MUST validate that `path` is in an allowed directory.** This
 * function does no path-traversal checking; that responsibility lives
 * with the IPC handler / file picker that produced the path. See
 * `electron/main/storage/file-operations.ts:isPathSafe` for the canonical check.
 */
export async function loadCollectionFromFile(path: string): Promise<OpenCollection> {
  const raw = await readFile(path, 'utf8');
  return parseOpenCollectionYAML(raw);
}

/**
 * Load a directory-layout OpenCollection from disk: reads `opencollection.yml`
 * (or `.yaml`) at `dir`, then walks subdirectories as folders and `*.yaml`
 * files as items. The result has `bundled: false`.
 *
 * **Caller MUST validate that `dir` is in an allowed directory.** Subdirectory
 * traversal during the walk is bounded by the on-disk layout (no symlink
 * resolution), but if `dir` itself is attacker-controlled, every path under
 * it becomes readable. See `electron/main/storage/file-operations.ts:isPathSafe`.
 */
export async function loadCollectionFromDir(dir: string): Promise<OpenCollection> {
  return (await loadCollectionDirectory(dir)).collection;
}

export interface LoadedCollectionDirectory {
  collection: OpenCollection;
  /** Relative files positively identified as OpenCollection-owned content. */
  managedFiles: string[];
}

export async function loadCollectionDirectory(dir: string): Promise<LoadedCollectionDirectory> {
  const rootPath = await findRootFile(dir);
  if (!rootPath) {
    throw new Error(`No opencollection.yml or opencollection.yaml in ${dir}`);
  }
  const rootRaw = await readFile(rootPath, 'utf8');
  const root = parseOpenCollectionYAML(rootRaw);
  const managedFiles = [relative(dir, rootPath).split(sep).join('/')];
  const items = await readItems(dir, dir, managedFiles);
  const collection = { ...root, items, bundled: false };
  assertBoundedDocument(collection);
  const validation = openCollectionSchema.safeParse(collection);
  if (!validation.success) throw new Error('Invalid OpenCollection directory layout');
  return { collection, managedFiles };
}

async function findRootFile(dir: string): Promise<string | null> {
  for (const candidate of ROOT_FILES) {
    const p = join(dir, candidate);
    try {
      const candidateStat = await lstat(p);
      if (candidateStat.isFile()) return p;
    } catch {
      // not present
    }
  }
  return null;
}

async function readItems(dir: string, rootDir: string, managedFiles: string[]): Promise<unknown[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  // Track each item alongside the source filename so we can break sort ties
  // deterministically. `readdir` order varies across filesystems; pinning the
  // tie-break to alphabetical filename keeps CI output stable across OSes.
  const indexed: Array<{ item: unknown; sortName: string }> = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      const folder = await readFolder(fullPath, rootDir, managedFiles);
      if (folder) indexed.push({ item: folder, sortName: entry.name });
      continue;
    }

    if (!entry.isFile()) continue;
    if (ROOT_FILES.includes(entry.name)) continue;
    if (entry.name === FOLDER_META) continue;
    if (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml')) continue;

    const raw = await readFile(fullPath, 'utf8');
    const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
    if (!isOpenCollectionRequestItem(parsed)) continue;
    managedFiles.push(relative(rootDir, fullPath).split(sep).join('/'));
    indexed.push({ item: parsed, sortName: entry.name });
  }

  // Primary sort: info.seq ascending (missing → MAX_SAFE_INTEGER).
  // Secondary sort: filename ascending. Together this gives deterministic
  // output regardless of the underlying filesystem's readdir order.
  indexed.sort((a, b) => {
    const sa = (a.item as { info?: { seq?: number } })?.info?.seq ?? Number.MAX_SAFE_INTEGER;
    const sb = (b.item as { info?: { seq?: number } })?.info?.seq ?? Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    return a.sortName.localeCompare(b.sortName);
  });

  return indexed.map((entry) => entry.item);
}

async function readFolder(
  dir: string,
  rootDir: string,
  managedFiles: string[]
): Promise<unknown | null> {
  const metaPath = join(dir, FOLDER_META);
  let meta: unknown = { info: { name: basename(dir) } };
  let hasMeta = false;
  try {
    const metaStat = await lstat(metaPath);
    if (!metaStat.isFile()) throw new Error('Folder metadata must be a regular file');
    const raw = await readFile(metaPath, 'utf8');
    meta = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
    assertBoundedDocument(meta);
    if (!folderSchema.safeParse(meta).success) {
      throw new Error('Invalid OpenCollection folder metadata');
    }
    managedFiles.push(relative(rootDir, metaPath).split(sep).join('/'));
    hasMeta = true;
  } catch {
    // _folder.yaml is optional; fall back to dir basename
  }
  const items = await readItems(dir, rootDir, managedFiles);
  if (!hasMeta && items.length === 0) return null;
  return { ...(meta as object), items };
}

function isOpenCollectionRequestItem(value: unknown): boolean {
  try {
    assertBoundedDocument(value);
  } catch {
    return false;
  }
  return [httpRequestSchema, grpcRequestSchema, graphqlRequestSchema, websocketRequestSchema].some(
    (schema) => schema.safeParse(value).success
  );
}

// Re-export for callers that need to write back later
export { serializeOpenCollectionYAML };
