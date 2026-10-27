import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Reporter, RunResult } from '../../reporters/types';
import { loadCollection } from '../collectionLoader';
import { walkPostmanFolder } from '../postmanFolder';
import { formatImportReport, isPostmanDocument } from '../postmanImport';
import { runCollection } from '../runner';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../../../../shared/collections/postman/__fixtures__/v3');
const KITCHEN = join(FIXTURES, 'kitchen-sink');
const NESTED = join(FIXTURES, 'nested');
const ALL_KINDS = join(FIXTURES, 'all-kinds.json');

let server: Server;
let baseUrl: string;
const hits: Array<{ url: string; headers: IncomingMessage['headers'] }> = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    hits.push({ url: req.url ?? '/', headers: req.headers });
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
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

const silentReporter: Reporter = { onEnd() {} };
const quietStderr = () => vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

function tmp(prefix = 'restura-pm-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function fileMap(dir: string, prefix: string): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[prefix + relative(dir, p).split('\\').join('/')] = readFileSync(p);
    }
  };
  walk(dir);
  return out;
}

function v21(items: unknown[], extra: Record<string, unknown> = {}): string {
  const dir = tmp();
  const path = join(dir, 'collection.json');
  writeFileSync(
    path,
    JSON.stringify({
      info: {
        _postman_id: 'abc',
        name: 'V21',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: items,
      ...extra,
    })
  );
  return path;
}

describe('loadCollection — Postman', () => {
  it('loads the v3 kitchen-sink folder via the shared parser', async () => {
    quietStderr();
    const loaded = await loadCollection(KITCHEN);
    expect(loaded.format).toBe('postman-v3');
    expect(loaded.meta.name).toBe('Kitchen Sink');
    const names = loaded.requests.map((r) => r.relativePath);
    expect(names).toContain('Users/List users');
    expect(names).toContain('Auth zoo/Hawk');
    expect(loaded.importReport?.sourceVersion).toBe('3.0');
    expect(loaded.importReport?.warnings.length).toBeGreaterThan(0);
  });

  it('loads the nested v3 folder with its folder path', async () => {
    quietStderr();
    const loaded = await loadCollection(NESTED);
    expect(loaded.format).toBe('postman-v3');
    const deep = loaded.requests.find((r) => r.folderPath.length >= 2);
    expect(deep?.folderPath.slice(0, 2)).toEqual(['Outer', 'Inner']);
  });

  it('loads a v3 single JSON file; skips placeholders and broker presets with a reason', async () => {
    const stderr = quietStderr();
    const loaded = await loadCollection(ALL_KINDS);
    expect(loaded.format).toBe('postman-v3');
    const types = loaded.requests.map((r) => r.type);
    expect(types).not.toContain('kafka');
    const names = loaded.requests.map((r) => r.request.name);
    // MCP stdio imports as a disabled placeholder folder (#1210), never a runnable request.
    expect(names.some((n) => n.includes('Local MCP'))).toBe(false);
    expect(names.some((n) => n.includes('Echo socket'))).toBe(false);
    const out = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toMatch(/Local MCP/);
    expect(out).toMatch(/skipping .*Echo socket/);
    expect(out).toMatch(/skipping Kafka preset/);
    // Secret variable: value-less, never folded in as an empty value.
    expect(loaded.meta.privateVariableNames).toContain('apiToken');
    expect(loaded.meta.variables?.some((v) => v.key === 'apiToken')).toBe(false);
  });

  it('loads a v3 .zip built in-test', async () => {
    quietStderr();
    const zip = zipSync(fileMap(KITCHEN, 'kitchen-sink/'));
    const path = join(tmp(), 'kitchen.zip');
    writeFileSync(path, zip);
    const fromZip = await loadCollection(path);
    const fromDir = await loadCollection(KITCHEN);
    expect(fromZip.format).toBe('postman-v3');
    expect(fromZip.requests.map((r) => r.relativePath).sort()).toEqual(
      fromDir.requests.map((r) => r.relativePath).sort()
    );
  });

  it('refuses an oversized zip before reading it', async () => {
    const path = join(tmp(), 'big.zip');
    writeFileSync(path, Buffer.alloc(2048));
    await expect(
      loadCollection(path, { postmanLimits: { maxArchiveBytes: 1024 } })
    ).rejects.toThrow(/too large/);
  });

  it('loads a v2.1 JSON collection', async () => {
    quietStderr();
    const path = v21([
      { name: 'Ping', request: { method: 'GET', url: 'https://example.com/ping' } },
    ]);
    const loaded = await loadCollection(path);
    expect(loaded.format).toBe('postman-v2');
    expect(loaded.importReport?.sourceVersion).toBe('2.1');
    expect(loaded.requests.map((r) => r.request.name)).toEqual(['Ping']);
  });

  it('marks requests with unsupported auth (own or inherited) as not sendable', async () => {
    quietStderr();
    const loaded = await loadCollection(KITCHEN);
    const hawk = loaded.requests.find((r) => r.relativePath === 'Auth zoo/Hawk');
    expect(hawk?.blocked).toMatch(/hawk/);
    const users = loaded.requests.find((r) => r.relativePath === 'Users/List users');
    expect(users?.blocked).toBeUndefined();
  });
});

describe('walkPostmanFolder', () => {
  it('skips symlinks (never follows them) and reports them', async () => {
    const outside = tmp();
    writeFileSync(join(outside, 'secret.request.yaml'), 'url: https://evil\n');
    const root = join(tmp(), 'Col');
    mkdirSync(join(root, '.resources'), { recursive: true });
    writeFileSync(join(root, '.resources', 'definition.yaml'), '$kind: collection\nname: Col\n');
    writeFileSync(
      join(root, 'A.request.yaml'),
      '$kind: http-request\nurl: https://a\nmethod: GET\n'
    );
    symlinkSync(join(outside, 'secret.request.yaml'), join(root, 'Link.request.yaml'));
    symlinkSync(outside, join(root, 'LinkedDir'));
    const walk = await walkPostmanFolder(root);
    expect(walk.entries.map((e) => e.path).sort()).toEqual([
      'Col/.resources/definition.yaml',
      'Col/A.request.yaml',
    ]);
    expect(walk.skippedSymlinks.sort()).toEqual(['Col/Link.request.yaml', 'Col/LinkedDir']);
  });

  it('names the root segment after the real folder for "."/".." relative paths', async () => {
    const root = join(tmp(), 'Col');
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(
      join(root, 'A.request.yaml'),
      '$kind: http-request\nurl: https://a\nmethod: GET\n'
    );
    const rel = relative(process.cwd(), root);
    for (const dir of [`${root}/.`, `${root}/sub/..`, `${rel}/sub/..`, `${rel}/.`]) {
      const walk = await walkPostmanFolder(dir);
      expect(walk.entries.map((e) => e.path)).toEqual(['Col/A.request.yaml']);
    }
    const loaded = await loadCollection(`${rel}/sub/..`);
    expect(loaded.requests.map((r) => r.request.name)).toEqual(['A']);
  });

  it('refuses an oversized file before reading it, and a file that grew past the cap', async () => {
    const root = join(tmp(), 'Big');
    mkdirSync(root);
    writeFileSync(join(root, 'A.request.yaml'), 'x'.repeat(200));
    await expect(loadCollection(root, { postmanLimits: { maxFileBytes: 100 } })).rejects.toThrow(
      /too large/
    );
    const walk = await walkPostmanFolder(root, { maxFileBytes: 300 });
    const entry = walk.entries[0]!;
    appendFileSync(join(root, 'A.request.yaml'), 'y'.repeat(200));
    await expect(entry.read()).rejects.toThrow(/too large/);
  });
});

describe('runCollection — Postman safety', () => {
  it('never sends an unsupported-auth request unauthenticated and says why', async () => {
    quietStderr();
    const path = v21(
      [
        {
          name: 'Hawk call',
          request: {
            method: 'GET',
            url: `${baseUrl}/hawk`,
            auth: { type: 'hawk', hawk: [{ key: 'authId', value: 'id' }] },
          },
        },
        {
          name: 'Folder',
          auth: { type: 'edgegrid', edgegrid: [{ key: 'accessToken', value: 't' }] },
          item: [{ name: 'Inherits', request: { method: 'GET', url: `${baseUrl}/inherit` } }],
        },
        { name: 'Fine', request: { method: 'GET', url: `${baseUrl}/fine` } },
      ],
      { auth: { type: 'bearer', bearer: [{ key: 'token', value: 'tok' }] } }
    );
    const result = await runCollection(
      path,
      { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true },
      silentReporter
    );
    expect(hits.map((h) => h.url)).toEqual(['/fine']);
    const byName = Object.fromEntries(result.requests.map((r) => [r.request.request.name, r]));
    expect(byName['Hawk call']?.passed).toBe(false);
    expect(byName['Hawk call']?.errorMessage).toMatch(/not sent.*hawk/i);
    expect(byName.Inherits?.errorMessage).toMatch(/not sent.*edgegrid/i);
    expect(result.summary.notSent).toBe(2);
    expect(result.importReport?.warnings.some((w) => w.kind === 'unsupported-auth')).toBe(true);
  });

  it('never launches an MCP stdio item from a Postman import', async () => {
    quietStderr();
    const marker = join(tmp(), 'spawned');
    const dir = tmp();
    const path = join(dir, 'mcp.json');
    writeFileSync(
      path,
      JSON.stringify({
        $kind: 'collection',
        name: 'MCP',
        items: [
          {
            $kind: 'mcp-request',
            name: 'Local',
            transport: 'stdio',
            command: `node -e "require('fs').writeFileSync('${marker}','x')"`,
          },
        ],
      })
    );
    const result = await runCollection(
      path,
      { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true },
      silentReporter
    );
    expect(existsSync(marker)).toBe(false);
    // The stdio item imports as a disabled placeholder folder: nothing runnable is left.
    expect(result.requests).toHaveLength(0);
  });

  it('--strict-import refuses to run when the report has entries', async () => {
    quietStderr();
    await expect(
      runCollection(
        KITCHEN,
        { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true, strictImport: true },
        silentReporter
      )
    ).rejects.toThrow(/--strict-import/);
    expect(hits).toHaveLength(0);
  });

  it('a request using a value-less secret variable fails explicitly unless provided', async () => {
    quietStderr();
    const path = join(tmp(), 'secret.json');
    writeFileSync(
      path,
      JSON.stringify({
        $kind: 'collection',
        name: 'Secret',
        variables: [{ key: 'apiToken', secret: true }],
        items: [
          {
            $kind: 'http-request',
            name: 'Uses secret',
            method: 'GET',
            url: `${baseUrl}/s?t={{apiToken}}`,
          },
        ],
      })
    );
    const opts = { bail: false, timeoutMs: 5000, allowLocalhost: true };
    await expect(runCollection(path, { ...opts, envVars: {} }, silentReporter)).rejects.toThrow(
      /apiToken/
    );
    expect(hits).toHaveLength(0);
    const ok: RunResult = await runCollection(
      path,
      { ...opts, envVars: { apiToken: 'real' } },
      silentReporter
    );
    expect(ok.summary.passed).toBe(1);
    expect(hits[0]?.url).toBe('/s?t=real');
  });
});

describe('runCollection — folder variable precedence', () => {
  it('a script-set value wins over the static folder default on the next request', async () => {
    quietStderr();
    const path = join(tmp(), 'fv.json');
    writeFileSync(
      path,
      JSON.stringify({
        $kind: 'collection',
        name: 'FV',
        variables: [{ key: 'tok', value: 'collection' }],
        items: [
          {
            $kind: 'collection',
            name: 'Folder',
            variables: [{ key: 'tok', value: 'folder' }],
            items: [
              {
                $kind: 'http-request',
                name: 'One',
                method: 'GET',
                url: `${baseUrl}/one?t={{tok}}`,
                scripts: [
                  { type: 'afterResponse', code: "pm.variables.set('tok', 'from-script');" },
                ],
              },
              {
                $kind: 'http-request',
                name: 'Two',
                method: 'GET',
                url: `${baseUrl}/two?t={{tok}}`,
              },
            ],
          },
        ],
      })
    );
    const result = await runCollection(
      path,
      { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true },
      silentReporter
    );
    expect(result.summary.passed).toBe(2);
    expect(hits.map((h) => h.url)).toEqual(['/one?t=folder', '/two?t=from-script']);
  });
});

describe('formatImportReport', () => {
  it('groups and counts entries', () => {
    const text = formatImportReport({
      sourceVersion: '3.0',
      warnings: [
        { kind: 'unsupported-auth', authType: 'hawk', requestName: 'A' },
        { kind: 'unsupported-auth', authType: 'hawk', requestName: 'B' },
        { kind: 'unsupported-method', method: 'PURGE', requestName: 'C' },
      ],
    });
    expect(text).toMatch(/3 entries/);
    expect(text).toMatch(/unsupported auth "hawk" \(2\): A, B/);
    expect(text).toMatch(/unsupported method "PURGE" \(1\): C/);
  });
});

describe('restura run --strict-import', () => {
  it('exits 2 without sending anything when the import report has entries', async () => {
    quietStderr();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const { executeRun } = await import('../../commands/run');
    const base = {
      bail: false,
      timeout: '5000',
      allowLocalhost: true,
      retry: '0',
      retryOn: 'network',
      reporter: 'stats',
    };
    await expect(executeRun(KITCHEN, { ...base, strictImport: true })).rejects.toThrow('exit:2');
    expect(exit).toHaveBeenCalledWith(2);
    expect(hits).toHaveLength(0);
  });
});

describe('isPostmanDocument — v2 schema host', () => {
  const doc = (schema: string) => ({ info: { name: 'x', schema } });

  it('accepts the real Postman schema hosts', () => {
    expect(
      isPostmanDocument(doc('https://schema.getpostman.com/json/collection/v2.1.0/collection.json'))
    ).toBe(true);
    expect(isPostmanDocument(doc('http://getpostman.com/json/collection/v2.0.0/'))).toBe(true);
  });

  it('matches the URL host, not a substring anywhere in the URL', () => {
    expect(isPostmanDocument(doc('https://evil.example/getpostman.com/collection.json'))).toBe(
      false
    );
    expect(isPostmanDocument(doc('https://getpostman.com.evil.example/c.json'))).toBe(false);
    expect(isPostmanDocument(doc('https://notgetpostman.com/c.json'))).toBe(false);
    expect(isPostmanDocument(doc('not a url getpostman.com'))).toBe(false);
  });
});
