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
    const dir = makeCollection(`pm.test('status is 200', () => pm.response.to.have.status(200));`);
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
    const dir = makeCollection(`pm.test('status is 500', () => pm.response.to.have.status(500));`);
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

describe('runCollection — pm.collectionVariables / pm.iterationData / pm.info', () => {
  it('pm.collectionVariables.get sees the collection-level variable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'restura-scripts-'));
    writeFileSync(
      join(dir, '_collection.yaml'),
      `name: Scripts\nvariables:\n  - { key: BASE, value: ${baseUrl}, enabled: true }\n  - { key: apiVersion, value: v2, enabled: true }\n`,
      'utf-8'
    );
    writeFileSync(
      join(dir, 'echo.http.yaml'),
      `name: Echo\nmethod: GET\nurl: '{{BASE}}/echo'\ntestScript: |\n  pm.test('collection var', () => pm.expect(pm.collectionVariables.get('apiVersion')).to.equal('v2'));\n`,
      'utf-8'
    );
    return runCollection(
      dir,
      { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true },
      new NoopReporter()
    ).then((result) => {
      const echo = find(result, 'Echo');
      expect(echo!.assertions).toEqual([{ name: 'collection var', passed: true }]);
    });
  });

  it('pm.collectionVariables.set carries forward to the next request in the same run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'restura-scripts-'));
    writeFileSync(
      join(dir, '_collection.yaml'),
      `name: Scripts\nvariables:\n  - { key: BASE, value: ${baseUrl}, enabled: true }\n`,
      'utf-8'
    );
    writeFileSync(
      join(dir, 'a.echo.http.yaml'),
      `name: A\nmethod: GET\nurl: '{{BASE}}/echo'\ntestScript: |\n  pm.collectionVariables.set('token', 'abc123');\n`,
      'utf-8'
    );
    writeFileSync(
      join(dir, 'b.echo.http.yaml'),
      `name: B\nmethod: GET\nurl: '{{BASE}}/echo'\ntestScript: |\n  pm.test('sees token from A', () => pm.expect(pm.collectionVariables.get('token')).to.equal('abc123'));\n`,
      'utf-8'
    );
    const result = await runCollection(
      dir,
      { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true },
      new NoopReporter()
    );
    const b = find(result, 'B');
    expect(b!.assertions).toEqual([{ name: 'sees token from A', passed: true }]);
  });

  it('pm.info reflects the real request name and eventName per phase', async () => {
    const dir = makeCollection(`
pm.test('request name', () => pm.expect(pm.info.requestName).to.equal('Echo'));
pm.test('event name', () => pm.expect(pm.info.eventName).to.equal('test'));
`);
    const result = await runCollection(
      dir,
      { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true },
      new NoopReporter()
    );
    const echo = find(result, 'Echo');
    expect(echo!.assertions).toEqual([
      { name: 'request name', passed: true },
      { name: 'event name', passed: true },
    ]);
  });

  it('pm.iterationData reflects the real data row during a data-driven run', async () => {
    const dir = makeCollection(`
pm.test('row value', () => pm.expect(pm.iterationData.get('user')).to.equal('alice'));
`);
    const result = await runCollection(
      dir,
      {
        envVars: {},
        bail: false,
        timeoutMs: 5000,
        allowLocalhost: true,
        iterations: [{ user: 'alice' }],
      },
      new NoopReporter()
    );
    const echo = find(result, 'Echo');
    expect(echo!.assertions).toEqual([{ name: 'row value', passed: true }]);
  });
});
