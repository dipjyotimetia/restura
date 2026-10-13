import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Reporter } from '../../reporters/types';
import { runCollection } from '../runner';

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

  it('warns once per run that a per-request httpVersion is not applied by the CLI', async () => {
    const dir = makeCollection('Forced h2', '/fast', { httpVersion: 'http2' });
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = await runCollection(dir, RUN_OPTS, new NoopReporter());
      // The request still runs (undici negotiates as usual).
      expect(result.requests[0]?.passed).toBe(true);
      const warnings = write.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => /httpVersion/.test(m));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/1 request/);
      expect(warnings[0]).toMatch(/desktop app/);
      // Per run, not per process: a second run warns again.
      await runCollection(dir, RUN_OPTS, new NoopReporter());
      expect(
        write.mock.calls.map((c) => String(c[0])).filter((m) => /httpVersion/.test(m))
      ).toHaveLength(2);
    } finally {
      write.mockRestore();
    }
  });

  it('does not warn when every request is on auto', async () => {
    const dir = makeCollection('Auto', '/fast', { httpVersion: 'auto' });
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await runCollection(dir, RUN_OPTS, new NoopReporter());
      expect(write.mock.calls.some((c) => /httpVersion/.test(String(c[0])))).toBe(false);
    } finally {
      write.mockRestore();
    }
  });
});
