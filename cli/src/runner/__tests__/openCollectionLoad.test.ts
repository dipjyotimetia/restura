import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCollection } from '../collectionLoader';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../../../fixtures');

describe('loadCollection — format detection', () => {
  it('loads an OpenCollection directory (opencollection.yml + per-request files)', async () => {
    const result = await loadCollection(join(FIXTURES, 'sample-opencollection'));
    expect(result.format).toBe('opencollection-dir');
    expect(result.meta.name).toBe('Sample OpenCollection');
    expect(result.meta.description).toBe('Demo OpenCollection-format collection for CLI tests');

    // Two requests, one at root + one inside the `users/` folder
    expect(result.requests).toHaveLength(2);
    const byName = Object.fromEntries(result.requests.map((r) => [r.request.name, r]));

    expect(byName['List posts']).toBeDefined();
    expect(byName['List posts']?.folderPath).toEqual([]);
    expect(byName['List posts']?.type).toBe('http');

    expect(byName['Get user']).toBeDefined();
    expect(byName['Get user']?.folderPath).toEqual(['users']);
    expect(byName['Get user']?.relativePath).toBe('users/Get user');

    // Script from `runtime.scripts` should land on `testScript`
    const getUser = byName['Get user']?.request;
    expect(getUser).toBeDefined();
    expect((getUser as { testScript?: string }).testScript).toContain('status is 200');
  });

  it('loads a bundled OpenCollection (single YAML file)', async () => {
    const result = await loadCollection(join(FIXTURES, 'sample-bundled.yaml'));
    expect(result.format).toBe('opencollection-file');
    expect(result.meta.name).toBe('Sample Bundled');
    expect(result.requests).toHaveLength(1);
    const r = result.requests[0]!;
    expect(r.type).toBe('http');
    expect(r.request.name).toBe('Ping');
    expect(r.folderPath).toEqual([]);
  });

  it('falls back to the legacy `_collection.yaml` format', async () => {
    const result = await loadCollection(join(FIXTURES, 'sample-collection'));
    expect(result.format).toBe('legacy-dir');
    expect(result.meta.name).toBe('Sample');
    expect(result.requests).toHaveLength(2);
    // Legacy loader populates filePath on every request
    for (const r of result.requests) {
      expect(r.filePath).toBeDefined();
      expect(r.folderPath).toEqual([]);
    }
  });

  it('throws with a clear message when no recognised layout is present', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'restura-empty-'));
    try {
      await expect(loadCollection(empty)).rejects.toThrow(/No recognised collection layout/);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('throws on a non-yaml file', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'restura-bad-'));
    try {
      const file = join(tmp, 'not-a-collection.txt');
      const { writeFile } = await import('node:fs/promises');
      await writeFile(file, 'hello');
      await expect(loadCollection(file)).rejects.toThrow(/Unsupported collection file extension/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
