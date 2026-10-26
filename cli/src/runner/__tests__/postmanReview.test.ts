import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importPostmanCollection } from '@shared/collections/postman';
import { hasUnsupportedPostmanAuth } from '@shared/collections/postman/common';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Reporter } from '../../reporters/types';
import { loadCollection } from '../collectionLoader';
import { executeRequest } from '../executors/dispatch';
import { executeHttp } from '../executors/http';
import { walkPostmanFolder } from '../postmanFolder';
import { runCollection } from '../runner';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALL_KINDS = resolve(
  __dirname,
  '../../../../shared/collections/postman/__fixtures__/v3/all-kinds.json'
);

let server: Server;
let baseUrl: string;
const hits: string[] = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    hits.push(req.url ?? '/');
    res.statusCode = 200;
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
});
afterEach(() => {
  hits.length = 0;
  vi.restoreAllMocks();
});

const silent: Reporter = { onEnd() {} };
const quiet = () => vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
const tmp = () => mkdtempSync(join(tmpdir(), 'restura-pm-review-'));
const runOpts = { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true };

function writeJson(doc: unknown): string {
  const path = join(tmp(), 'c.json');
  writeFileSync(path, JSON.stringify(doc));
  return path;
}

const V21 = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

describe('hasUnsupportedPostmanAuth (shared seam)', () => {
  it('returns the Postman type for an unsupported node and undefined otherwise', () => {
    const { collection } = importPostmanCollection({
      info: { name: 'S', schema: V21 },
      item: [
        {
          name: 'Hawk folder',
          auth: { type: 'hawk', hawk: [{ key: 'authId', value: 'id' }] },
          item: [{ name: 'R', request: { method: 'GET', url: 'https://x' } }],
        },
        {
          name: 'Own hawk',
          request: { method: 'GET', url: 'https://x', auth: { type: 'hawk', hawk: [] } },
        },
        {
          name: 'Bearer',
          request: {
            method: 'GET',
            url: 'https://x',
            auth: { type: 'bearer', bearer: [{ key: 'token', value: 't' }] },
          },
        },
      ],
    });
    const [folder, own, bearer] = collection.items;
    expect(hasUnsupportedPostmanAuth(folder!)).toBe('hawk');
    expect(hasUnsupportedPostmanAuth(own!)).toBe('hawk');
    expect(hasUnsupportedPostmanAuth(bearer!)).toBeUndefined();
    expect(hasUnsupportedPostmanAuth(folder!.items![0]!)).toBeUndefined();
  });
});

describe('postmanFolder read() TOCTOU', () => {
  async function walked() {
    const root = join(tmp(), 'Col');
    mkdirSync(root);
    const file = join(root, 'A.request.yaml');
    writeFileSync(file, 'url: https://a\n');
    const walk = await walkPostmanFolder(root);
    return { file, entry: walk.entries[0]!, root };
  }

  it('refuses a file swapped for a symlink after the walk', async () => {
    const { file, entry } = await walked();
    const outside = join(tmp(), 'secret.yaml');
    writeFileSync(outside, 'secret: 1\n');
    rmSync(file);
    symlinkSync(outside, file);
    await expect(entry.read()).rejects.toThrow();
  });

  it('refuses a file replaced by a different file after the walk', async () => {
    const { file, entry, root } = await walked();
    const other = join(root, 'other.tmp');
    writeFileSync(other, 'url: https://b\n');
    renameSync(other, file);
    await expect(entry.read()).rejects.toThrow(/changed/);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a file swapped for a FIFO after the walk',
    async () => {
      const { file, entry } = await walked();
      rmSync(file);
      execFileSync('mkfifo', [file]);
      await expect(entry.read()).rejects.toThrow(/not a regular file|changed/);
    }
  );
});

describe('executor-level refusal of blocked requests', () => {
  const blocked = {
    relativePath: 'B',
    folderPath: [],
    type: 'http' as const,
    blocked: 'not sent: test reason',
    request: {
      id: 'b',
      name: 'B',
      type: 'http' as const,
      method: 'GET' as const,
      url: '',
      headers: [],
      params: [],
      body: { type: 'none' as const },
      auth: { type: 'none' as const },
    },
  };

  it('executeHttp and executeRequest never send a blocked request', async () => {
    const item = { ...blocked, request: { ...blocked.request, url: `${baseUrl}/x` } };
    const opts = { vars: {}, timeoutMs: 2000, allowLocalhost: true };
    const a = await executeHttp(item, opts);
    const b = await executeRequest(item, opts);
    expect(hits).toHaveLength(0);
    expect(a.errorMessage).toBe('not sent: test reason');
    expect(b.errorMessage).toBe('not sent: test reason');
    expect(a.passed).toBe(false);
  });
});

describe('runner: Postman review fixes', () => {
  it('a blocked request does not abort the run in the secret pre-check', async () => {
    quiet();
    const path = writeJson({
      $kind: 'collection',
      name: 'S',
      variables: [{ key: 'apiToken', secret: true }],
      items: [
        {
          $kind: 'http-request',
          name: 'Hawk uses secret',
          method: 'GET',
          url: `${baseUrl}/h?t={{apiToken}}`,
          auth: { type: 'hawk', credentials: [{ key: 'authId', value: 'id' }] },
        },
        { $kind: 'http-request', name: 'Fine', method: 'GET', url: `${baseUrl}/fine` },
      ],
    });
    const result = await runCollection(path, runOpts, silent);
    expect(hits).toEqual(['/fine']);
    expect(result.summary.notSent).toBe(1);
  });

  it('resolves v3 folder variables like the app (outer → inner, inner wins)', async () => {
    quiet();
    const path = writeJson({
      $kind: 'collection',
      name: 'FV',
      variables: [{ key: 'seg', value: 'collection' }],
      items: [
        {
          $kind: 'collection',
          name: 'Outer',
          variables: [
            { key: 'seg', value: 'outer' },
            { key: 'only', value: 'o' },
          ],
          items: [
            {
              $kind: 'collection',
              name: 'Inner',
              variables: [{ key: 'seg', value: 'inner' }],
              items: [
                {
                  $kind: 'http-request',
                  name: 'R',
                  method: 'GET',
                  url: `${baseUrl}/{{seg}}/{{only}}`,
                },
              ],
            },
          ],
        },
        { $kind: 'http-request', name: 'Top', method: 'GET', url: `${baseUrl}/{{seg}}` },
      ],
    });
    await runCollection(path, runOpts, silent);
    expect(hits).toEqual(['/inner/o', '/collection']);
  });

  it('placeholder item kinds are import-report entries (seen by --strict-import / reporters)', async () => {
    quiet();
    const loaded = await loadCollection(ALL_KINDS);
    const placeholders = (loaded.importReport?.warnings ?? []).filter(
      (w) => w.kind === 'unmodelled-construct' && w.construct === 'unsupported-item-kind'
    );
    expect(placeholders.map((w) => ('requestName' in w ? w.requestName : ''))).toEqual(
      expect.arrayContaining(['Echo socket', 'Chat', 'Ask model', 'Rows'])
    );
  });
});
