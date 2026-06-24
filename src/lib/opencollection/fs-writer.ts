import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OpenCollection } from './schemas';
import { serializeOpenCollectionYAML } from './serializer';

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
  await mkdir(dir, { recursive: true });
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
