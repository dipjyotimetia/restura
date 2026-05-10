import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serializeOpenCollectionYAML } from './serializer';
import type { OpenCollection } from './schemas';

export async function saveCollectionToFile(oc: OpenCollection, path: string): Promise<void> {
  const compacted = (compact(oc) ?? {}) as Record<string, unknown>;
  const yaml = serializeOpenCollectionYAML({ ...compacted, bundled: true } as OpenCollection);
  await writeFile(path, yaml, 'utf8');
}

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
  for (const it of items) {
    const item = it as Record<string, unknown>;
    if (isFolder(item)) {
      const slug = slugify((item.info as { name: string }).name);
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
      const slug = slugify(info.name);
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

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'item'
  );
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
