import { describe, it, expect } from 'vitest';
import { loadCollectionFromFile, loadCollectionFromDir } from '../fs-reader';

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
});
