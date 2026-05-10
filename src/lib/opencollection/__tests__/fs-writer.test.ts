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
});
