import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Reporter, RequestRunResult, RunResult } from '../../reporters/types';
import { runCollection } from '../runner';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ headers: req.headers }));
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
  onEnd(_r: RunResult): void {}
}

function indent(script: string): string {
  return script.trim().replace(/\n/g, '\n  ');
}

function makeCollection(preRequestScript: string, testScript: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'restura-script-parity-'));
  writeFileSync(
    join(dir, '_collection.yaml'),
    `name: Parity\nvariables:\n  - { key: BASE, value: ${baseUrl}, enabled: true }\n`,
    'utf-8'
  );
  writeFileSync(
    join(dir, 'echo.http.yaml'),
    [
      'name: Echo',
      'method: GET',
      "url: '{{BASE}}/echo'",
      'headers:',
      "  - { key: X-Remove, value: 'r', enabled: true }",
      "  - { key: Accept, value: 'application/xml', enabled: true }",
      'preRequestScript: |',
      `  ${indent(preRequestScript)}`,
      'testScript: |',
      `  ${indent(testScript)}`,
      '',
    ].join('\n'),
    'utf-8'
  );
  return dir;
}

async function run(dir: string): Promise<RequestRunResult | undefined> {
  const result = await runCollection(
    dir,
    { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true },
    new NoopReporter()
  );
  return result.requests.find((r) => r.request.request.name === 'Echo');
}

describe('CLI scripts match the app', () => {
  it('gives test scripts the raw body text and the status text', async () => {
    const echo = await run(
      makeCollection(
        `console.log('pre');`,
        `
pm.test('raw body', () => pm.expect(typeof response.body).to.equal('string'));
pm.test('status text', () => pm.expect(pm.response.status).to.equal('OK'));
pm.test('be.json', () => { pm.response.to.be.json; });
pm.test('json()', () => pm.expect(pm.response.json()).to.have.property('headers'));
`
      )
    );
    expect(echo?.assertions).toEqual([
      { name: 'raw body', passed: true },
      { name: 'status text', passed: true },
      { name: 'be.json', passed: true },
      { name: 'json()', passed: true },
    ]);
  });

  it('sends pm.request.headers edits made in the pre-request script', async () => {
    const echo = await run(
      makeCollection(
        `
pm.request.headers.add({ key: 'X-Trace', value: 't-1' });
pm.request.headers.upsert({ key: 'accept', value: 'application/json' });
pm.request.headers.remove('X-Remove');
`,
        `
const sent = pm.response.json().headers;
pm.test('added', () => pm.expect(sent['x-trace']).to.equal('t-1'));
pm.test('upserted', () => pm.expect(sent.accept).to.equal('application/json'));
pm.test('removed', () => pm.expect(sent['x-remove']).to.equal(undefined));
`
      )
    );
    expect(echo?.assertions).toEqual([
      { name: 'added', passed: true },
      { name: 'upserted', passed: true },
      { name: 'removed', passed: true },
    ]);
  });
});
