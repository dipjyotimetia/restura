import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadCollectionDirectory,
  loadCollectionFromDir,
  loadCollectionFromFile,
} from '../fs-reader';

const FIXTURES = 'tests/fixtures/opencollection';

describe('fs-reader', () => {
  it('loads a bundled single-file collection', async () => {
    const oc = await loadCollectionFromFile(`${FIXTURES}/simple-http.yaml`);
    expect(oc.info.name).toBe('Simple HTTP Demo');
    expect(oc.items?.length).toBe(1);
  });

  it('loads a directory-layout collection with one folder and one request', async () => {
    const oc = await loadCollectionFromDir(`${FIXTURES}/dir-layout`);
    expect(oc.info.name).toBe('Dir Layout Demo');
    expect(oc.items?.length).toBe(1);
    const folder = oc.items?.[0] as { info: { name: string }; items: unknown[] };
    expect(folder.info.name).toBe('users');
    expect(folder.items.length).toBe(1);
  });

  it('throws on directory missing opencollection.yml', async () => {
    await expect(loadCollectionFromDir('/tmp/definitely-not-an-oc-dir-12345')).rejects.toThrow();
  });

  it('ignores unrelated YAML and does not claim it as managed content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-reader-'));
    await writeFile(
      join(dir, 'opencollection.yml'),
      'opencollection: 1.0.0\ninfo:\n  name: Demo\n'
    );
    await writeFile(join(dir, 'workflow.yaml'), 'name: user workflow\nsteps: []\n');
    await writeFile(
      join(dir, 'request-looking.yaml'),
      'info: { type: http, name: Broken }\nhttp: {}\n'
    );
    await mkdir(join(dir, 'unrelated'));
    await writeFile(join(dir, 'unrelated', 'notes.yaml'), 'notes: keep me\n');

    const loaded = await loadCollectionDirectory(dir);

    expect(loaded.collection.items).toEqual([]);
    expect(loaded.managedFiles).toEqual(['opencollection.yml']);
  });

  it('refuses a symlinked collection root file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-reader-link-'));
    const outside = join(dir, '..', `${Date.now()}-outside.yaml`);
    await writeFile(outside, 'opencollection: 1.0.0\ninfo: { name: Outside }\n');
    await symlink(outside, join(dir, 'opencollection.yml'));

    await expect(loadCollectionFromDir(dir)).rejects.toThrow(/No opencollection/);
  });

  it('does not follow symlinked folder metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-reader-folder-link-'));
    await writeFile(
      join(dir, 'opencollection.yml'),
      'opencollection: 1.0.0\ninfo: { name: Safe }\n'
    );
    await mkdir(join(dir, 'linked-folder'));
    const outside = join(dir, '..', `${Date.now()}-folder.yaml`);
    await writeFile(outside, 'info: { name: Outside metadata }\n');
    await symlink(outside, join(dir, 'linked-folder', '_folder.yaml'));

    const loaded = await loadCollectionDirectory(dir);

    expect(loaded.collection.items).toEqual([]);
    expect(loaded.managedFiles).toEqual(['opencollection.yml']);
  });
});
