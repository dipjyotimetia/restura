import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthConfig } from '@/types';
import { type LoadedRequest, loadCollection } from '../collectionLoader';

/**
 * A bundled OpenCollection exercising Postman-style inheritance:
 *   - collection-level (root `request`) default auth + scripts
 *   - folder-level (`request`) default auth + scripts
 *   - a request with its own auth (must win over inherited)
 *
 * This is exactly how the desktop app EXPORTS a collection that authenticates
 * once at the root — so the CLI must thread these down or every inheriting
 * request goes out unauthenticated.
 */
const BUNDLED = `opencollection: "1.0.0"
info:
  name: Inheritance
  version: "0.1.0"
bundled: true
request:
  auth:
    type: bearer
    token: ROOT_TOKEN
  scripts:
    - type: before-request
      code: |
        pm.environment.set('rootRan', '1');
    - type: tests
      code: |
        pm.test('root-test', () => true);
items:
  - info:
      type: http
      name: RootInherits
      seq: 1
    http:
      method: GET
      url: https://api.example.com/a
  - info:
      type: http
      name: RootOwnAuth
      seq: 2
    http:
      method: GET
      url: https://api.example.com/b
      auth:
        type: bearer
        token: OWN_TOKEN
  - info:
      name: folder1
      seq: 3
    request:
      auth:
        type: apikey
        key: X-Api-Key
        value: FOLDER_KEY
        placement: header
      scripts:
        - type: before-request
          code: |
            pm.environment.set('folderRan', '1');
    items:
      - info:
          type: http
          name: FolderInherits
          seq: 1
        http:
          method: GET
          url: https://api.example.com/c
        runtime:
          scripts:
            - type: before-request
              code: |
                pm.environment.set('ownRan', '1');
`;

let dir: string;
let file: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'restura-inherit-'));
  file = join(dir, 'collection.yaml');
  await writeFile(file, BUNDLED, 'utf-8');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function byName(reqs: LoadedRequest[]): Record<string, LoadedRequest> {
  return Object.fromEntries(reqs.map((r) => [r.request.name, r]));
}

describe('loadCollection — auth & script inheritance', () => {
  it('applies collection-level default auth to a request with no auth of its own', async () => {
    const { requests } = await loadCollection(file);
    const auth = byName(requests)['RootInherits']!.request.auth as AuthConfig;
    expect(auth.type).toBe('bearer');
    expect(auth.bearer?.token).toBe('ROOT_TOKEN');
  });

  it("keeps a request's own auth over the inherited collection auth", async () => {
    const { requests } = await loadCollection(file);
    const auth = byName(requests)['RootOwnAuth']!.request.auth as AuthConfig;
    expect(auth.type).toBe('bearer');
    expect(auth.bearer?.token).toBe('OWN_TOKEN');
  });

  it('applies folder-level default auth (nearest ancestor wins) over collection auth', async () => {
    const { requests } = await loadCollection(file);
    const auth = byName(requests)['FolderInherits']!.request.auth as AuthConfig;
    expect(auth.type).toBe('api-key');
    expect(auth.apiKey?.value).toBe('FOLDER_KEY');
  });

  it('combines collection + folder + request pre-request scripts in parent→child order', async () => {
    const { requests } = await loadCollection(file);
    const script = byName(requests)['FolderInherits']!.request.preRequestScript ?? '';
    expect(script).toContain('rootRan');
    expect(script).toContain('folderRan');
    expect(script).toContain('ownRan');
    // Parent-to-child order: collection before folder before request.
    expect(script.indexOf('rootRan')).toBeLessThan(script.indexOf('folderRan'));
    expect(script.indexOf('folderRan')).toBeLessThan(script.indexOf('ownRan'));
  });

  it('threads collection-level test scripts onto inheriting requests', async () => {
    const { requests } = await loadCollection(file);
    const test = byName(requests)['RootInherits']!.request.testScript ?? '';
    expect(test).toContain('root-test');
  });
});
