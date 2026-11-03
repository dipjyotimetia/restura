import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateItem } from '@shared/collections/tree-edit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { internalToOC } from '../from-internal';
import { loadCollectionFromDir, loadCollectionFromFile } from '../fs-reader';
import { saveCollectionToDir, saveCollectionToFile } from '../fs-writer';
import type { OpenCollection } from '../schemas';
import { ocToInternal } from '../to-internal';

const httpItem = (name: string, extra: Record<string, unknown> = {}) => ({
  info: { type: 'http' as const, name, ...extra },
  http: { method: 'GET', url: `https://example.com/${encodeURIComponent(name)}` },
});

/** Names of an OC `items` array, recursing into folders as `[name, [...children]]`. */
function itemNames(items: unknown): unknown[] {
  if (!Array.isArray(items)) return [];
  return items.map((it) => {
    const node = it as { info?: { name?: unknown }; items?: unknown };
    return Array.isArray(node.items) ? [node.info?.name, itemNames(node.items)] : node.info?.name;
  });
}

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
    // Only the stamped sibling positions (`info.seq`, one item per level here) differ.
    const users = original.items?.[0] as { info: object; items: Array<{ info: object }> };
    expect(reloaded).toEqual({
      ...original,
      items: [
        {
          ...users,
          info: { ...users.info, seq: 1 },
          items: users.items.map((it) => ({ ...it, info: { ...it.info, seq: 1 } })),
        },
      ],
    });
  });

  it('carries collection- and folder-level request.scripts through the dir layout', async () => {
    const oc: OpenCollection = {
      opencollection: '1.0.0',
      info: { name: 'Scripted' },
      request: { scripts: [{ type: 'before-request', code: 'rs.root.pre()' }] },
      items: [
        {
          info: { name: 'users' },
          request: { scripts: [{ type: 'tests', code: 'rs.folder.test()' }] },
          items: [
            {
              info: { type: 'http', name: 'Get User' },
              http: { method: 'GET', url: '/u/1' },
            },
          ],
        },
      ],
    } as OpenCollection;
    await saveCollectionToDir(oc, tmp);

    // Scripts land in the on-disk root + folder metadata files.
    const root = await readFile(join(tmp, 'opencollection.yml'), 'utf8');
    expect(root).toContain('rs.root.pre()');
    const folderMeta = await readFile(join(tmp, 'users', '_folder.yaml'), 'utf8');
    expect(folderMeta).toContain('rs.folder.test()');

    // ...and survive the reload symmetrically.
    const reloaded = await loadCollectionFromDir(tmp);
    expect((reloaded.request as { scripts?: Array<{ code: string }> }).scripts?.[0]?.code).toBe(
      'rs.root.pre()'
    );
    // biome-ignore lint/suspicious/noExplicitAny: Item is folder|request union
    const folder = (reloaded.items ?? [])[0] as any;
    expect(folder.request.scripts[0].code).toBe('rs.folder.test()');
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

    // Reloading preserves all three names in their saved order.
    const reloaded = await loadCollectionFromDir(tmp);
    expect(itemNames(reloaded.items)).toEqual(['User', 'User !', 'User?']);
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

  it('removes stale managed files while preserving unrelated files', async () => {
    const first: OpenCollection = {
      opencollection: '1.0.0',
      info: { name: 'Reconciled' },
      items: [
        { info: { type: 'http', name: 'Old request' }, http: { method: 'GET', url: '/old' } },
      ],
    };
    await saveCollectionToDir(first, tmp);
    await writeFile(join(tmp, 'README.md'), 'keep me', 'utf8');

    const second: OpenCollection = {
      ...first,
      items: [
        { info: { type: 'http', name: 'New request' }, http: { method: 'GET', url: '/new' } },
      ],
    };
    await saveCollectionToDir(second, tmp);

    await expect(access(join(tmp, 'old-request.yaml'))).rejects.toThrow();
    expect(await readFile(join(tmp, 'new-request.yaml'), 'utf8')).toContain('New request');
    expect(await readFile(join(tmp, 'README.md'), 'utf8')).toBe('keep me');
  });

  it('refuses to follow destination symlinks while reconciling managed files', async () => {
    const outside = join(tmpdir(), `oc-outside-${Date.now()}.yaml`);
    await writeFile(outside, 'do not overwrite', 'utf8');
    await symlink(outside, join(tmp, 'escape.yaml'));
    const oc: OpenCollection = {
      opencollection: '1.0.0',
      info: { name: 'Safe' },
      items: [{ info: { type: 'http', name: 'Escape' }, http: { method: 'GET', url: '/escape' } }],
    };

    await expect(saveCollectionToDir(oc, tmp)).rejects.toThrow(/symbolic link/i);
    expect(await readFile(outside, 'utf8')).toBe('do not overwrite');
    await rm(outside, { force: true });
  });

  it('ignores non-collection paths injected into the managed manifest', async () => {
    await writeFile(join(tmp, 'README.md'), 'keep me', 'utf8');
    await writeFile(
      join(tmp, '.restura-managed-files.json'),
      JSON.stringify({ version: 1, files: ['README.md'] }),
      'utf8'
    );
    await saveCollectionToDir({ opencollection: '1.0.0', info: { name: 'Safe' }, items: [] }, tmp);
    expect(await readFile(join(tmp, 'README.md'), 'utf8')).toBe('keep me');
  });

  it('refuses a stale managed path routed through an intermediate symlink', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'oc-outside-dir-'));
    await writeFile(join(outsideDir, 'victim.yaml'), 'do not delete', 'utf8');
    await symlink(outsideDir, join(tmp, 'linked'));
    await writeFile(
      join(tmp, '.restura-managed-files.json'),
      JSON.stringify({ version: 1, files: ['linked/victim.yaml'] }),
      'utf8'
    );

    await expect(
      saveCollectionToDir({ opencollection: '1.0.0', info: { name: 'Safe' }, items: [] }, tmp)
    ).rejects.toThrow(/symbolic link/i);
    expect(await readFile(join(outsideDir, 'victim.yaml'), 'utf8')).toBe('do not delete');
    await rm(outsideDir, { recursive: true, force: true });
  });

  it('preserves unrelated YAML when no managed manifest exists', async () => {
    await writeFile(
      join(tmp, 'workflow.yaml'),
      'name: deploy\non: push\njobs: { build: { runs-on: ubuntu-latest } }\n'
    );
    await saveCollectionToDir(
      { opencollection: '1.0.0', info: { name: 'Current' }, items: [] },
      tmp
    );
    expect(await readFile(join(tmp, 'workflow.yaml'), 'utf8')).toContain('name: deploy');
  });

  it('removes only caller-confirmed managed files when bootstrapping a manifest', async () => {
    await writeFile(
      join(tmp, 'old-request.yaml'),
      'info: { type: http, name: Old }\nhttp: { method: GET, url: /old }\n'
    );
    await writeFile(join(tmp, 'workflow.yaml'), 'name: deploy\non: push\n');
    await saveCollectionToDir(
      { opencollection: '1.0.0', info: { name: 'Current' }, items: [] },
      tmp,
      { previousManagedFiles: ['old-request.yaml'] }
    );
    await expect(access(join(tmp, 'old-request.yaml'))).rejects.toThrow();
    expect(await readFile(join(tmp, 'workflow.yaml'), 'utf8')).toContain('name: deploy');
  });

  it('refuses to overwrite an unowned file at a generated request path', async () => {
    await writeFile(join(tmp, 'list-users.yaml'), 'user-owned: true\n');
    const collection: OpenCollection = {
      opencollection: '1.0.0',
      info: { name: 'Current' },
      items: [
        {
          info: { type: 'http', name: 'List users' },
          http: { method: 'GET', url: '/users' },
        },
      ],
    };

    await expect(saveCollectionToDir(collection, tmp)).rejects.toThrow(/unowned file/i);
    expect(await readFile(join(tmp, 'list-users.yaml'), 'utf8')).toBe('user-owned: true\n');
  });

  it('aborts when a previously managed file changed after the caller snapshot', async () => {
    const rootPath = join(tmp, 'opencollection.yml');
    const original = 'opencollection: 1.0.0\ninfo: { name: Original }\n';
    const external = 'opencollection: 1.0.0\ninfo: { name: External edit }\n';
    await writeFile(rootPath, original);
    const fingerprint = createHash('sha256').update(original).digest('hex');
    await writeFile(rootPath, external);

    await expect(
      saveCollectionToDir(
        { opencollection: '1.0.0', info: { name: 'Restura edit' }, items: [] },
        tmp,
        {
          previousManagedFiles: ['opencollection.yml'],
          expectedPreviousFingerprints: { 'opencollection.yml': fingerprint },
        }
      )
    ).rejects.toThrow(/changed since it was loaded/i);
    expect(await readFile(rootPath, 'utf8')).toBe(external);
  });

  it('rolls back only its own mutations and preserves a concurrent unowned file', async () => {
    const collection: OpenCollection = {
      opencollection: '1.0.0',
      info: { name: 'Current' },
      items: [
        { info: { type: 'http', name: 'A' }, http: { method: 'GET', url: '/a' } },
        { info: { type: 'http', name: 'B' }, http: { method: 'GET', url: '/b' } },
      ],
    };

    await expect(
      saveCollectionToDir(collection, tmp, {
        previousManagedFiles: [],
        beforeMutation: async (file) => {
          if (file === 'b.yaml') await writeFile(join(tmp, file), 'external: true\n');
        },
      })
    ).rejects.toThrow(/unowned file/i);
    await expect(access(join(tmp, 'a.yaml'))).rejects.toThrow();
    expect(await readFile(join(tmp, 'b.yaml'), 'utf8')).toBe('external: true\n');
  });

  it('preserves a concurrently created ownership manifest and aborts the save', async () => {
    let injected = false;
    const manifestPath = join(tmp, '.restura-managed-files.json');
    await expect(
      saveCollectionToDir({ opencollection: '1.0.0', info: { name: 'Current' }, items: [] }, tmp, {
        previousManagedFiles: [],
        expectedManifestFingerprint: null,
        beforeMutation: async () => {
          if (injected) return;
          injected = true;
          await writeFile(manifestPath, '{"external":true}\n');
        },
      })
    ).rejects.toThrow(/changed since it was loaded/i);
    expect(await readFile(manifestPath, 'utf8')).toBe('{"external":true}\n');
    await expect(access(join(tmp, 'opencollection.yml'))).rejects.toThrow();
  });

  it('refuses to create a collection through a symlinked parent directory', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'oc-parent-outside-'));
    await symlink(outsideDir, join(tmp, 'linked-parent'));
    await expect(
      saveCollectionToDir(
        { opencollection: '1.0.0', info: { name: 'Safe' }, items: [] },
        join(tmp, 'linked-parent', 'collection'),
        { trustedRoot: tmp }
      )
    ).rejects.toThrow(/symbolic link/i);
    await expect(access(join(outsideDir, 'collection'))).rejects.toThrow();
    await rm(outsideDir, { recursive: true, force: true });
  });
  it('keeps a request named "OpenCollection" at the root and inside a folder (A1)', async () => {
    const oc: OpenCollection = {
      opencollection: '1.0.0',
      info: { name: 'Reserved names' },
      items: [
        httpItem('OpenCollection'),
        { info: { name: 'Folder' }, items: [httpItem('OpenCollection'), httpItem('Other')] },
        httpItem('Other'),
      ],
    };
    const first = await saveCollectionToDir(oc, tmp);
    // The writer never emits a request file that collides with a root file name.
    expect(first.managedFiles).not.toContain('opencollection.yaml');
    expect(first.managedFiles).not.toContain('folder/opencollection.yaml');
    const reloaded = await loadCollectionFromDir(tmp);
    expect(itemNames(reloaded.items)).toEqual([
      'OpenCollection',
      ['Folder', ['OpenCollection', 'Other']],
      'Other',
    ]);
    // A second save over the first one (the desktop save-on-every-edit path)
    // succeeds and still round-trips.
    await saveCollectionToDir(reloaded, tmp, { previousManagedFiles: first.managedFiles });
    expect(itemNames((await loadCollectionFromDir(tmp)).items)).toEqual(itemNames(reloaded.items));
  });

  it('recovers requests an older writer saved under a root or folder file name (A1)', async () => {
    await saveCollectionToDir(
      { opencollection: '1.0.0', info: { name: 'Legacy' }, items: [httpItem('Kept')] },
      tmp
    );
    const { serializeOpenCollectionYAML } = await import('../serializer');
    // Old layouts slugged a request named "OpenCollection" to these paths.
    await writeFile(
      join(tmp, 'opencollection.yaml'),
      serializeOpenCollectionYAML(httpItem('OpenCollection') as unknown as OpenCollection)
    );
    await saveCollectionToDir(
      {
        opencollection: '1.0.0',
        info: { name: 'Legacy' },
        items: [httpItem('Kept'), { info: { name: 'Sub' }, items: [httpItem('Sub item')] }],
      },
      tmp,
      { previousManagedFiles: ['opencollection.yml', 'kept.yaml'] }
    );
    await writeFile(
      join(tmp, 'sub', 'opencollection.yml'),
      serializeOpenCollectionYAML(httpItem('Nested') as unknown as OpenCollection)
    );
    const reloaded = await loadCollectionFromDir(tmp);
    expect(reloaded.info.name).toBe('Legacy');
    expect(itemNames(reloaded.items)).toEqual(
      expect.arrayContaining(['OpenCollection', 'Kept', ['Sub', ['Sub item', 'Nested']]])
    );
  });

  it('preserves interleaved folder/request sibling order across save -> reload (A2)', async () => {
    const oc: OpenCollection = {
      opencollection: '1.0.0',
      info: { name: 'Order' },
      items: [
        httpItem('Zeta'),
        { info: { name: 'Middle' }, items: [httpItem('Inner B'), httpItem('Inner A')] },
        httpItem('Alpha'),
        { info: { name: 'Another' }, items: [] },
        httpItem('Beta'),
      ],
    };
    await saveCollectionToDir(oc, tmp);
    const reloaded = await loadCollectionFromDir(tmp);
    expect(itemNames(reloaded.items)).toEqual([
      'Zeta',
      ['Middle', ['Inner B', 'Inner A']],
      'Alpha',
      ['Another', []],
      'Beta',
    ]);
  });

  it('stamps the array position over stale cached seq values, so a moved item keeps its place (A2)', async () => {
    // Cached `info.seq` from an earlier load disagrees with the edited order:
    // "Moved" lost its bag on the move (no seq) and now sits first.
    const oc: OpenCollection = {
      opencollection: '1.0.0',
      info: { name: 'Moved' },
      items: [
        httpItem('Moved'),
        httpItem('First', { seq: 1 }),
        { info: { name: 'Folder', seq: 2 }, items: [httpItem('X', { seq: 9 })] },
        httpItem('Last', { seq: 3 }),
      ],
    };
    const first = await saveCollectionToDir(oc, tmp);
    const reloaded = await loadCollectionFromDir(tmp);
    expect(itemNames(reloaded.items)).toEqual(['Moved', 'First', ['Folder', ['X']], 'Last']);

    // Move "Last" to the front of the reloaded document and save again.
    const items = [...(reloaded.items ?? [])];
    const last = items.pop();
    await saveCollectionToDir({ ...reloaded, items: [last, ...items] } as OpenCollection, tmp, {
      previousManagedFiles: first.managedFiles,
    });
    expect(itemNames((await loadCollectionFromDir(tmp)).items)).toEqual([
      'Last',
      'Moved',
      'First',
      ['Folder', ['X']],
    ]);
  });
  it('keeps folder docs and request defaults when a child request is edited and re-saved (B1)', async () => {
    const oc = {
      opencollection: '1.0.0',
      info: { name: 'Edited' },
      items: [
        {
          info: { name: 'Folder', description: 'Folder desc' },
          docs: 'Folder docs',
          request: { headers: [{ name: 'X-Tenant', value: 'acme' }] },
          items: [httpItem('Child')],
        },
      ],
    } as OpenCollection;
    const first = await saveCollectionToDir(oc, tmp);
    const internal = ocToInternal(await loadCollectionFromDir(tmp));
    const child = internal.items[0]?.items?.[0];
    if (!child?.request) throw new Error('fixture');
    const edited = updateItem(internal, child.id, {
      request: { ...child.request, url: 'https://example.com/edited' } as never,
    });
    await saveCollectionToDir(internalToOC(edited), tmp, {
      previousManagedFiles: first.managedFiles,
    });
    const folder = (await loadCollectionFromDir(tmp)).items?.[0] as {
      info: { description?: unknown };
      docs?: unknown;
      request?: { headers?: unknown };
      items: Array<{ http?: { url?: string } }>;
    };
    expect(folder.info.description).toBe('Folder desc');
    expect(folder.docs).toBe('Folder docs');
    expect(folder.request?.headers).toEqual([{ name: 'X-Tenant', value: 'acme' }]);
    expect(folder.items[0]?.http?.url).toBe('https://example.com/edited');
  });
});
