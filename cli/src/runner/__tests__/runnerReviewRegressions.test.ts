import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Reporter } from '../../reporters/types';
import { loadIterationData } from '../dataLoader';
import { executeSse } from '../executors/sse';
import { runCollection } from '../runner';

/**
 * Regressions from the collection-run review. Every case runs the real
 * loader / executor / runner against an in-process server.
 */

let server: Server;
let baseUrl: string;
const hits: Array<{ url: string; auth: string | undefined }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '/';
    hits.push({ url, auth: req.headers.authorization });
    if (url === '/token-redirect') {
      res.writeHead(307, { location: `${baseUrl}/token-target` });
      return res.end();
    }
    if (url === '/token-target') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"access_token":"STOLEN","token_type":"Bearer"}');
    }
    if (url === '/hang') return; // accept, never answer
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  hits.length = 0;
});

class Quiet implements Reporter {
  onEnd(): void {}
}

const RUN = { bail: false, timeoutMs: 5000, allowLocalhost: true } as const;

function ocFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'restura-review-'));
  const file = join(dir, 'collection.yaml');
  writeFileSync(file, `opencollection: "1.0.0"\ninfo:\n  name: Review\nbundled: true\n${body}`);
  return file;
}

describe('collection-run review regressions (CLI)', () => {
  it('refuses an OAuth2 token endpoint redirect instead of re-posting the client secret', async () => {
    const file = ocFile(`request:
  auth:
    type: oauth2
    clientId: CLIENT
    clientSecret: SECRET
    tokenUrl: "${baseUrl}/token-redirect"
    scope: review-redirect
items:
  - info: { type: http, name: R, seq: 1 }
    http: { method: GET, url: "${baseUrl}/resource" }
`);
    const result = await runCollection(file, { ...RUN, envVars: {} }, new Quiet());
    expect(result.requests[0]?.passed).toBe(false);
    expect(result.requests[0]?.errorMessage).toMatch(/redirect/i);
    expect(hits.map((h) => h.url)).not.toContain('/token-target');
    expect(hits.map((h) => h.url)).not.toContain('/resource');
  });

  it('an SSE server that never answers fails the item instead of passing as an empty 200', async () => {
    const outcome = await executeSse(
      {
        relativePath: 'hang',
        folderPath: [],
        type: 'sse',
        request: {
          id: 's',
          name: 'Hang',
          type: 'sse',
          url: `${baseUrl}/hang`,
          headers: [],
          params: [],
          auth: { type: 'none' },
        },
      },
      { vars: {}, timeoutMs: 5000, allowLocalhost: true, sseDurationMs: 300 }
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.status).toBe(0);
    expect(outcome.errorMessage).toMatch(/no response/);
  });

  it('--data JSON keeps nested values as JSON and tolerates a BOM, like the app', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'restura-data-'));
    const file = join(dir, 'rows.json');
    writeFileSync(file, `﻿${JSON.stringify([{ payload: { a: 1 }, list: [1, 2], n: 3, '': 'x' }])}`);
    expect(await loadIterationData(file)).toEqual([{ payload: '{"a":1}', list: '[1,2]', n: '3' }]);
  });

  it('a legacy _collection.yaml auth is inherited by requests with no auth of their own', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'restura-legacy-'));
    writeFileSync(
      join(dir, '_collection.yaml'),
      'name: Legacy\nauth:\n  type: bearer\n  bearer:\n    token: "{{token}}"\n'
    );
    writeFileSync(
      join(dir, 'get.http.yaml'),
      [
        'name: Get',
        'method: GET',
        `url: "${baseUrl}/legacy"`,
        'headers: []',
        'params: []',
        'body:',
        '  type: none',
        'auth:',
        '  type: none',
        '',
      ].join('\n')
    );
    const result = await runCollection(dir, { ...RUN, envVars: { token: 'LEG' } }, new Quiet());
    expect(result.requests[0]?.passed, result.requests[0]?.errorMessage).toBe(true);
    expect(hits.find((h) => h.url === '/legacy')?.auth).toBe('Bearer LEG');
  });

  it('pm.variables.unset in a test script drops the run write, so the env value shows again', async () => {
    const item = (seq: number, name: string, path: string, test?: string) =>
      `  - info: { type: http, name: ${name}, seq: ${seq} }\n    http: { method: GET, url: "${baseUrl}${path}" }\n` +
      (test
        ? `    runtime:\n      scripts:\n        - type: tests\n          code: "${test}"\n`
        : '');
    const file = ocFile(
      `items:\n${item(1, 'Set', '/set', "pm.variables.set('x', 'script');")}${item(
        2,
        'Use',
        '/use?x={{x}}',
        "pm.variables.unset('x');"
      )}${item(3, 'After', '/after?x={{x}}')}`
    );
    const result = await runCollection(file, { ...RUN, envVars: { x: 'env' } }, new Quiet());
    expect(result.summary.passed).toBe(3);
    expect(hits.map((h) => h.url)).toEqual(['/set', '/use?x=script', '/after?x=env']);
  });

  it('a pre-request pm.variables.unset keeps the value for THIS request (app parity)', async () => {
    const file = ocFile(`items:
  - info: { type: http, name: Unset, seq: 1 }
    http: { method: GET, url: "${baseUrl}/u?x={{x}}" }
    runtime:
      scripts:
        - type: before-request
          code: "pm.variables.unset('x');"
`);
    const result = await runCollection(file, { ...RUN, envVars: { x: 'env' } }, new Quiet());
    expect(result.summary.passed).toBe(1);
    expect(hits.map((h) => h.url)).toEqual(['/u?x=env']);
  });

  it('a legacy _collection.yaml secret variable does not shadow --env with an empty value', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'restura-legacy-secret-'));
    writeFileSync(
      join(dir, '_collection.yaml'),
      'name: Legacy\nvariables:\n  - key: token\n    value: ""\n    enabled: true\n    secret: true\n'
    );
    writeFileSync(
      join(dir, 'get.http.yaml'),
      [
        'name: Get',
        'method: GET',
        `url: "${baseUrl}/leg?t={{token}}"`,
        'headers: []',
        'params: []',
        'body:',
        '  type: none',
        'auth:',
        '  type: none',
        '',
      ].join('\n')
    );
    const result = await runCollection(dir, { ...RUN, envVars: { token: 'ENV' } }, new Quiet());
    expect(result.requests[0]?.passed, result.requests[0]?.errorMessage).toBe(true);
    expect(hits.map((h) => h.url)).toEqual(['/leg?t=ENV']);
  });
});
