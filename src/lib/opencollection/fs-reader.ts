import { readFile, readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import yaml from 'js-yaml';
import { parseOpenCollectionYAML, serializeOpenCollectionYAML } from './serializer';
import type { OpenCollection } from './schemas';

const ROOT_FILES = ['opencollection.yml', 'opencollection.yaml'];
const FOLDER_META = '_folder.yaml';

export async function loadCollectionFromFile(path: string): Promise<OpenCollection> {
  const raw = await readFile(path, 'utf8');
  return parseOpenCollectionYAML(raw);
}

export async function loadCollectionFromDir(dir: string): Promise<OpenCollection> {
  const rootPath = await findRootFile(dir);
  if (!rootPath) {
    throw new Error(`No opencollection.yml or opencollection.yaml in ${dir}`);
  }
  const rootRaw = await readFile(rootPath, 'utf8');
  const root = parseOpenCollectionYAML(rootRaw);
  const items = await readItems(dir);
  return { ...root, items, bundled: false };
}

async function findRootFile(dir: string): Promise<string | null> {
  for (const candidate of ROOT_FILES) {
    const p = join(dir, candidate);
    try {
      await stat(p);
      return p;
    } catch {
      // not present
    }
  }
  return null;
}

async function readItems(dir: string): Promise<unknown[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const items: unknown[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      const folder = await readFolder(fullPath);
      items.push(folder);
      continue;
    }

    if (!entry.isFile()) continue;
    if (ROOT_FILES.includes(entry.name)) continue;
    if (entry.name === FOLDER_META) continue;
    if (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml')) continue;

    const raw = await readFile(fullPath, 'utf8');
    const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
    items.push(parsed);
  }

  // Sort items by info.seq if present, else by file name (stable)
  items.sort((a: any, b: any) => {
    const sa = a?.info?.seq ?? Number.MAX_SAFE_INTEGER;
    const sb = b?.info?.seq ?? Number.MAX_SAFE_INTEGER;
    return sa - sb;
  });

  return items;
}

async function readFolder(dir: string): Promise<unknown> {
  const metaPath = join(dir, FOLDER_META);
  let meta: unknown = { info: { name: basename(dir) } };
  try {
    const raw = await readFile(metaPath, 'utf8');
    meta = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
  } catch {
    // _folder.yaml is optional; fall back to dir basename
  }
  const items = await readItems(dir);
  return { ...(meta as object), items };
}

// Re-export for callers that need to write back later
export { serializeOpenCollectionYAML };
