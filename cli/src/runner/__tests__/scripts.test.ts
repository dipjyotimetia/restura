import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCollection } from '../runner';
import type { Reporter, RunResult, RequestRunResult } from '../../reporters/types';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    if (url === '/echo') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, who: 'restura' }));
    } else {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

class NoopReporter implements Reporter {
  onEnd(_r: RunResult): void {}
}

function makeCollection(testScript: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'restura-scripts-'));
  writeFileSync(
    join(dir, '_collection.yaml'),
    `name: Scripts\nvariables:\n  - { key: BASE, value: ${baseUrl}, enabled: true }\n`,
    'utf-8'
  );
  writeFileSync(
    join(dir, 'echo.http.yaml'),
    `name: Echo\nmethod: GET\nurl: '{{BASE}}/echo'\ntestScript: |\n  ${testScript.replace(/\n/g, '\n  ')}\n`,
    'utf-8'
  );
  return dir;
}

function find(result: RunResult, name: string): RequestRunResult | undefined {
  return result.requests.find((r) => r.request.request.name === name);
}

describe('runCollection — test scripts', () => {
  it('reports a passing pm.test assertion and marks the request passed', async () => {
    const dir = makeCollection(
      `pm.test('status is 200', () => pm.response.to.have.status(200));`
    );
    const result = await runCollection(
      dir,
      { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true },
      new NoopReporter()
    );
    const echo = find(result, 'Echo');
    expect(echo).toBeDefined();
    expect(echo!.passed).toBe(true);
    expect(echo!.assertions).toEqual([{ name: 'status is 200', passed: true }]);
  });

  it('marks the request failed when a pm.test assertion fails', async () => {
    const dir = makeCollection(
      `pm.test('status is 500', () => pm.response.to.have.status(500));`
    );
    const result = await runCollection(
      dir,
      { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true },
      new NoopReporter()
    );
    const echo = find(result, 'Echo');
    expect(echo).toBeDefined();
    expect(echo!.passed).toBe(false);
    expect(echo!.assertions).toHaveLength(1);
    expect(echo!.assertions![0]!.passed).toBe(false);
  });

  it('captures multiple assertions; overall pass requires all to pass', async () => {
    const dir = makeCollection(`
pm.test('status is 200', () => pm.response.to.have.status(200));
pm.test('always fails', () => { throw new Error('nope'); });
`);
    const result = await runCollection(
      dir,
      { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true },
      new NoopReporter()
    );
    const echo = find(result, 'Echo');
    expect(echo).toBeDefined();
    expect(echo!.assertions).toHaveLength(2);
    expect(echo!.passed).toBe(false);
  });
});
