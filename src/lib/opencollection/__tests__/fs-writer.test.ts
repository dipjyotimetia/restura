import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveCollectionToDir, saveCollectionToFile } from '../fs-writer';
import { loadCollectionFromDir, loadCollectionFromFile } from '../fs-reader';
import type { OpenCollection } from '../schemas';

describe('fs-writer', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'oc-writer-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('saves a bundled single-file collection', async () => {
    const oc: OpenCollection = {
      opencollection: '1.0.0',
      info: { name: 'Bundled Demo' },
      bundled: true,
      items: [
        {
          info: { type: 'http', name: 'Get root' },
          http: { method: 'GET', url: 'https://example.com' },
        },
      ],
    };
    const dest = join(tmp, 'bundled.yaml');
    await saveCollectionToFile(oc, dest);
    const content = await readFile(dest, 'utf8');
    expect(content).toContain('opencollection: "1.0.0"');
    expect(content).toContain('Get root');
    const reloaded = await loadCollectionFromFile(dest);
    expect(reloaded.info.name).toBe('Bundled Demo');
  });

  it('saves a directory layout with slugified filenames', async () => {
    const oc: OpenCollection = {
      opencollection: '1.0.0',
      info: { name: 'Dir Demo' },
      items: [
        {
          info: { name: 'users', description: 'User CRUD' },
          items: [
            {
              info: { type: 'http', name: 'Get User By ID' },
              http: { method: 'GET', url: '/u/1' },
            },
          ],
        },
      ],
    };
    await saveCollectionToDir(oc, tmp);
    const root = await readFile(join(tmp, 'opencollection.yml'), 'utf8');
    expect(root).toContain('Dir Demo');
    const folderMeta = await readFile(join(tmp, 'users', '_folder.yaml'), 'utf8');
    expect(folderMeta).toContain('users');
    const req = await readFile(join(tmp, 'users', 'get-user-by-id.yaml'), 'utf8');
    expect(req).toContain('Get User By ID');
  });

  it('roundtrips dir-layout fixture without semantic loss', async () => {
    const original = await loadCollectionFromDir('tests/fixtures/opencollection/dir-layout');
    await saveCollectionToDir(original, tmp);
    const reloaded = await loadCollectionFromDir(tmp);
    expect(reloaded).toEqual(original);
  });

  it('cleans up empty trailing arrays so YAML stays compact', async () => {
    const oc: OpenCollection = {
      opencollection: '1.0.0',
      info: { name: 'Compact' },
      items: [],
    };
    const dest = join(tmp, 'c.yaml');
    await saveCollectionToFile(oc, dest);
    const content = await readFile(dest, 'utf8');
    expect(content).not.toContain('items: []');
  });

  it('disambiguates colliding slugs by appending -2, -3, ...', async () => {
    const oc: OpenCollection = {
      opencollection: '1.0.0',
      info: { name: 'Collisions' },
      items: [
        { info: { type: 'http', name: 'User' }, http: { method: 'GET', url: '/u' } },
        { info: { type: 'http', name: 'User !' }, http: { method: 'GET', url: '/u2' } },
        { info: { type: 'http', name: 'User?' }, http: { method: 'GET', url: '/u3' } },
      ],
    };
    await saveCollectionToDir(oc, tmp);

    // All three slug variants exist on disk — no item silently overwritten.
    const onDisk1 = await readFile(join(tmp, 'user.yaml'), 'utf8');
    const onDisk2 = await readFile(join(tmp, 'user-2.yaml'), 'utf8');
    const onDisk3 = await readFile(join(tmp, 'user-3.yaml'), 'utf8');
    expect(onDisk1).toMatch(/User/);
    expect(onDisk2).toMatch(/User/);
    expect(onDisk3).toMatch(/User/);

    // Reloading preserves all three names (order may vary; just count).
    const reloaded = await loadCollectionFromDir(tmp);
    const names = (reloaded.items ?? []).map((it: any) => it.info.name);
    expect(names.length).toBe(3);
    expect(names).toEqual(expect.arrayContaining(['User', 'User !', 'User?']));
  });

  it('also dedupes folder slugs with -2 suffix', async () => {
    const oc: OpenCollection = {
      opencollection: '1.0.0',
      info: { name: 'FolderCollisions' },
      items: [
        { info: { name: 'Users' }, items: [] },
        { info: { name: 'Users !' }, items: [] },
      ],
    };
    await saveCollectionToDir(oc, tmp);
    const m1 = await readFile(join(tmp, 'users', '_folder.yaml'), 'utf8');
    const m2 = await readFile(join(tmp, 'users-2', '_folder.yaml'), 'utf8');
    expect(m1).toMatch(/Users/);
    expect(m2).toMatch(/Users/);
  });
});
