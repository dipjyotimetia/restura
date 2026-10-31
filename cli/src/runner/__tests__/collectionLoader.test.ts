import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HttpRequest } from '@shared/types';
import { afterAll, describe, expect, it } from 'vitest';
import { type LoadedRequest, loadCollection } from '../collectionLoader';
import { executeHttp } from '../executors/http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(__dirname, '../../../fixtures/sample-collection');

describe('form rows saved without an enabled flag still send', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });
  const tempDir = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'restura-form-rows-'));
    dirs.push(dir);
    return dir;
  };

  async function sentBody(item: LoadedRequest): Promise<unknown> {
    let body: unknown;
    await executeHttp(item, {
      vars: {},
      timeoutMs: 1000,
      allowLocalhost: true,
      fetcher: async (req) => {
        body = req.body;
        return {
          status: 200,
          statusText: 'OK',
          headers: {},
          text: async () => '',
          contentLengthHeader: '0',
        };
      },
    });
    return body;
  }

  const rowFlags = (item: LoadedRequest | undefined) =>
    (item?.request as HttpRequest).body.formData?.map((row) => [row.key, row.enabled]);

  it('OpenCollection: a part with no flag is enabled; an explicit false stays off', async () => {
    const dir = await tempDir();
    const file = join(dir, 'collection.yaml');
    await writeFile(
      file,
      `opencollection: "1.0.0"
info:
  name: Rows
  version: "0.1.0"
bundled: true
items:
  - info:
      type: http
      name: Form
      seq: 1
    http:
      method: POST
      url: https://api.example.com/a
      body:
        formUrlEncoded:
          parts:
            - { key: plain, value: "1", type: text }
            - { key: on, value: "2", type: text, enabled: true }
            - { key: off, value: "3", type: text, enabled: false }
`
    );
    const { requests } = await loadCollection(file);
    expect(rowFlags(requests[0])).toEqual([
      ['plain', true],
      ['on', true],
      ['off', false],
    ]);
    expect(await sentBody(requests[0] as LoadedRequest)).toBe('plain=1&on=2');
  });

  it('legacy layout: the same rule, multipart included', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, '_collection.yaml'), 'name: Rows\n');
    await writeFile(
      join(dir, 'a.http.yaml'),
      `name: Form
method: POST
url: https://api.example.com/a
body:
  type: form-data
  formData:
    - { key: plain, value: "1", type: text }
    - { key: off, value: "3", type: text, enabled: false }
`
    );
    const { requests } = await loadCollection(dir);
    expect(rowFlags(requests[0])).toEqual([
      ['plain', true],
      ['off', false],
    ]);
    const sent = (await sentBody(requests[0] as LoadedRequest)) as FormData;
    expect([...sent.keys()]).toEqual(['plain']);
  });
});

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
