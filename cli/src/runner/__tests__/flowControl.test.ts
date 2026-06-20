import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCollection } from '../runner';
import type { Reporter, RunResult } from '../../reporters/types';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
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
  onEnd(): void {}
}

function makeCollection(reqs: Array<{ file: string; name: string; testScript?: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'restura-flow-'));
  writeFileSync(
    join(dir, '_collection.yaml'),
    `name: Flow\nvariables:\n  - { key: BASE, value: ${baseUrl}, enabled: true }\n`,
    'utf-8'
  );
  for (const r of reqs) {
    let body = `name: ${r.name}\nmethod: GET\nurl: '{{BASE}}/x'\n`;
    if (r.testScript) body += `testScript: |\n  ${r.testScript.replace(/\n/g, '\n  ')}\n`;
    writeFileSync(join(dir, r.file), body, 'utf-8');
  }
  return dir;
}

function names(result: RunResult): string[] {
  return result.requests.map((r) => r.request.request.name);
}

const RUN_OPTS = { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true } as const;

describe('runCollection — setNextRequest flow control', () => {
  it('jumps forward, skipping intermediate requests', async () => {
    const dir = makeCollection([
      { file: 'a.http.yaml', name: 'A', testScript: `pm.execution.setNextRequest('C');` },
      { file: 'b.http.yaml', name: 'B' },
      { file: 'c.http.yaml', name: 'C' },
    ]);
    const result = await runCollection(dir, RUN_OPTS, new NoopReporter());
    expect(names(result)).toEqual(['A', 'C']);
  });

  it('ends the iteration when setNextRequest(null) is called', async () => {
    const dir = makeCollection([
      { file: 'a.http.yaml', name: 'A', testScript: `pm.execution.setNextRequest(null);` },
      { file: 'b.http.yaml', name: 'B' },
    ]);
    const result = await runCollection(dir, RUN_OPTS, new NoopReporter());
    expect(names(result)).toEqual(['A']);
  });

  it('surfaces an error for an unknown setNextRequest target', async () => {
    const dir = makeCollection([
      { file: 'a.http.yaml', name: 'A', testScript: `pm.execution.setNextRequest('Nope');` },
    ]);
    const result = await runCollection(dir, RUN_OPTS, new NoopReporter());
    const hasErr = result.requests.some((r) =>
      (r.errorMessage ?? '').includes('no runnable with that name')
    );
    expect(hasErr).toBe(true);
  });
});
