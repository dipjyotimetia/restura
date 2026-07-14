import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCollection } from '../collectionLoader';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(__dirname, '../../../fixtures/sample-collection');

describe('loadCollection', () => {
  it('reads _collection.yaml metadata', async () => {
    const result = await loadCollection(fixtureDir);
    expect(result.meta.name).toBe('Sample');
    expect(result.meta.description).toBe('Demo collection for CLI tests');
    expect(result.meta.variables).toEqual([
      { key: 'API_BASE', value: 'https://api.example.com', enabled: true },
    ]);
    // The plan-spec: variable list uses the file-collection KeyValue (no id)
    expect(result.meta.variables?.[0]).not.toHaveProperty('id');
  });

  it('discovers all *.http.yaml files', async () => {
    const result = await loadCollection(fixtureDir);
    expect(result.requests).toHaveLength(2);
    const names = result.requests.map((r) => r.request.name).sort();
    expect(names).toEqual(['Get user', 'List posts']);
  });

  it('classifies request type from filename suffix', async () => {
    const result = await loadCollection(fixtureDir);
    for (const r of result.requests) {
      expect(r.type).toBe('http');
    }
  });

  it('populates id, headers, and testScript on parsed HttpRequest', async () => {
    const result = await loadCollection(fixtureDir);
    const getUser = result.requests.find((r) => r.request.name === 'Get user');
    expect(getUser).toBeDefined();
    expect(getUser!.type).toBe('http');
    const req = getUser!.request as Extract<(typeof getUser)['request'], { type: 'http' }>;
    expect(req.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(req.method).toBe('GET');
    expect(req.headers).toHaveLength(1);
    expect(req.headers[0]).toMatchObject({
      key: 'Accept',
      value: 'application/json',
      enabled: true,
    });
    expect(req.headers[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(req.testScript).toContain("pm.test('status is 200'");
    expect(req.body).toEqual({ type: 'none' });
    expect(req.auth).toEqual({ type: 'none' });
  });

  it('returns relative paths from the collection root', async () => {
    const result = await loadCollection(fixtureDir);
    const relPaths = result.requests.map((r) => r.relativePath).sort();
    expect(relPaths).toEqual(['get-user.http.yaml', 'list-posts.http.yaml']);
  });

  it('throws for missing _collection.yaml', async () => {
    await expect(loadCollection('/nonexistent/path/does/not/exist')).rejects.toThrow();
  });
});
