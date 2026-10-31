import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseEnvVarFlags, withIterationCount } from '../../commands/run';
import type { Reporter } from '../../reporters/types';
import { loadEnv } from '../envLoader';
import { runCollection } from '../runner';

// Newman-parity gaps closed in the CLI runner: skipRequest, variables carried
// across iterations, ancestor scripts in separate scopes, Postman env files.

let server: Server;
let baseUrl: string;
const hits: string[] = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    hits.push(req.url ?? '');
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

class NoopReporter implements Reporter {
  onEnd(): void {}
}

const RUN_OPTS = { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true } as const;

/** A one-file Postman v2.1 collection. */
function postman(collection: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'restura-newman-'));
  const file = join(dir, 'c.postman_collection.json');
  writeFileSync(
    file,
    JSON.stringify({
      info: {
        name: 'P',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      ...collection,
    })
  );
  return file;
}

const pre = (code: string) => [{ listen: 'prerequest', script: { exec: [code] } }];
const test = (code: string) => [{ listen: 'test', script: { exec: [code] } }];

describe('CLI runner — Newman parity', () => {
  it('pm.execution.skipRequest() sends nothing and skips the test script', async () => {
    hits.length = 0;
    const file = postman({
      item: [
        {
          name: 'Skipped',
          event: [...pre('pm.execution.skipRequest();'), ...test('pm.test("never", () => {});')],
          request: { method: 'GET', url: `${baseUrl}/skipped` },
        },
        { name: 'Sent', request: { method: 'GET', url: `${baseUrl}/sent` } },
      ],
    });
    const result = await runCollection(file, RUN_OPTS, new NoopReporter());
    expect(hits).toEqual(['/sent']);
    const skipped = result.requests[0]!;
    expect(skipped).toMatchObject({ skipped: true, passed: true });
    expect(skipped.assertions).toBeUndefined();
    expect(result.summary).toMatchObject({ total: 2, passed: 2, skipped: 1 });
  });

  it('collection and request scripts may declare the same const (separate scopes)', async () => {
    const file = postman({
      event: pre('const token = "c"; pm.environment.set("fromCollection", token);'),
      item: [
        {
          name: 'R',
          event: [
            ...pre('const token = "r";'),
            ...test(
              'pm.test("both ran", () => pm.expect(pm.environment.get("fromCollection")).to.equal("c"));'
            ),
          ],
          request: { method: 'GET', url: `${baseUrl}/r` },
        },
      ],
    });
    const result = await runCollection(file, RUN_OPTS, new NoopReporter());
    expect(result.requests[0]?.errorMessage).toBeUndefined();
    expect(result.requests[0]?.assertions).toEqual([{ name: 'both ran', passed: true }]);
  });

  it('script-set variables survive into the next iteration; row values do not leak', async () => {
    hits.length = 0;
    const file = postman({
      item: [
        {
          name: 'R',
          event: pre('if (pm.info.iteration === 0) pm.environment.set("token", "t1");'),
          request: { method: 'GET', url: `${baseUrl}/r?token={{token}}&only={{only}}` },
        },
      ],
    });
    await runCollection(
      file,
      { ...RUN_OPTS, iterations: [{ only: 'first' }, {}] },
      new NoopReporter()
    );
    expect(hits).toEqual(['/r?token=t1&only=first', '/r?token=t1&only=%7B%7Bonly%7D%7D']);
  });

  it('--env-var overrides a collection variable', async () => {
    hits.length = 0;
    const file = postman({
      variable: [{ key: 'path', value: 'collection' }],
      item: [{ name: 'R', request: { method: 'GET', url: `${baseUrl}/{{path}}` } }],
    });
    await runCollection(
      file,
      { ...RUN_OPTS, envVars: { path: 'env' }, overrideVars: { path: 'cli' } },
      new NoopReporter()
    );
    expect(hits).toEqual(['/cli']);
  });

  it('--delay-request pauses between requests', async () => {
    const file = postman({
      item: [
        { name: 'A', request: { method: 'GET', url: `${baseUrl}/a` } },
        { name: 'B', request: { method: 'GET', url: `${baseUrl}/b` } },
      ],
    });
    const started = Date.now();
    await runCollection(file, { ...RUN_OPTS, delayRequestMs: 150 }, new NoopReporter());
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });
});

describe('CLI flags — Newman parity', () => {
  it('loads a Postman environment export, skipping disabled rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'restura-env-'));
    const file = join(dir, 'dev.postman_environment.json');
    writeFileSync(
      file,
      JSON.stringify({
        id: 'e1',
        name: 'Dev',
        _postman_variable_scope: 'environment',
        values: [
          { key: 'base', value: 'https://x', enabled: true },
          { key: 'off', value: 'no', enabled: false },
          { key: 'port', value: 8080, enabled: true },
          { key: 'secret', value: 's', type: 'secret', enabled: true },
        ],
      })
    );
    expect(await loadEnv(file)).toEqual({ base: 'https://x', port: '8080', secret: 's' });
  });

  it('a flat env file with a `values` key is still a flat env file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'restura-env-'));
    const file = join(dir, 'env.json');
    writeFileSync(file, JSON.stringify({ values: 'v', other: 'o' }));
    expect(await loadEnv(file)).toEqual({ values: 'v', other: 'o' });
  });

  it('parses --env-var pairs and rejects a missing key', () => {
    expect(parseEnvVarFlags(['a=1', 'b=x=y', 'c='])).toEqual({ a: '1', b: 'x=y', c: '' });
    expect(() => parseEnvVarFlags(['nokey'])).toThrow(/key=value/);
    expect(() => parseEnvVarFlags(['=v'])).toThrow(/key=value/);
  });

  it('--iteration-count repeats empty iterations or reuses the last data row', () => {
    expect(withIterationCount([], 3)).toEqual([{}, {}, {}]);
    expect(withIterationCount([{ a: '1' }, { a: '2' }], 3)).toEqual([
      { a: '1' },
      { a: '2' },
      { a: '2' },
    ]);
    expect(withIterationCount([{ a: '1' }, { a: '2' }], 1)).toEqual([{ a: '1' }]);
    expect(withIterationCount([{ a: '1' }], undefined)).toEqual([{ a: '1' }]);
  });
});
