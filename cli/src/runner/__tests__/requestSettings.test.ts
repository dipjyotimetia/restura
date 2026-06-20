import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCollection } from '../runner';
import type { Reporter } from '../../reporters/types';

let server: Server;
let baseUrl: string;
const pending: ServerResponse[] = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if ((req.url ?? '').startsWith('/slow')) {
      // Hold the response open; the client should abort first if its timeout
      // is short enough. Tracked so afterAll can release them cleanly.
      pending.push(res);
      return;
    }
    res.statusCode = 200;
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const res of pending) res.end('late');
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

class NoopReporter implements Reporter {
  onEnd(): void {}
}

/** Legacy collection — the only on-disk format that carries per-request `settings`. */
function makeCollection(name: string, path: string, settings?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'restura-settings-'));
  writeFileSync(
    join(dir, '_collection.yaml'),
    `name: Settings\nvariables:\n  - { key: BASE, value: ${baseUrl}, enabled: true }\n`,
    'utf-8'
  );
  let body = `name: ${name}\nmethod: GET\nurl: '{{BASE}}${path}'\n`;
  if (settings) body += `settings: ${JSON.stringify(settings)}\n`;
  writeFileSync(join(dir, 'req.http.yaml'), body, 'utf-8');
  return dir;
}

const RUN_OPTS = { envVars: {}, bail: false, timeoutMs: 30000, allowLocalhost: true } as const;

describe('runCollection — per-request settings', () => {
  it('honors a per-request timeout that is shorter than the global timeout', async () => {
    // Global timeout is 30s; the request sets its own 150ms timeout against a
    // server that never responds → it must abort via the per-request timeout.
    const dir = makeCollection('Slow', '/slow', {
      timeout: 150,
      followRedirects: true,
      maxRedirects: 5,
      verifySsl: true,
    });
    const result = await runCollection(dir, RUN_OPTS, new NoopReporter());
    const r = result.requests.find((x) => x.request.request.name === 'Slow')!;
    expect(r.errorMessage).toBeDefined();
    expect(r.passed).toBe(false);
  }, 10000);

  it('without a per-request timeout, the global timeout governs (fast request passes)', async () => {
    const dir = makeCollection('Fast', '/fast');
    const result = await runCollection(dir, RUN_OPTS, new NoopReporter());
    const r = result.requests.find((x) => x.request.request.name === 'Fast')!;
    expect(r.passed).toBe(true);
    expect(r.status).toBe(200);
  });
});
