import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LiveReporter } from '../../reporters/live';
import { redactRunResult } from '../../reporters/redact';
import type { Reporter, RunResult } from '../../reporters/types';
import { runCollection } from '../runner';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.statusCode = 200;
    res.end('ok');
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
  return script.replace(/\n/g, '\n  ');
}

function makeCollection(pre: string, test: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'restura-console-'));
  writeFileSync(
    join(dir, '_collection.yaml'),
    `name: Console\nvariables:\n  - { key: BASE, value: ${baseUrl}, enabled: true }\n`,
    'utf-8'
  );
  writeFileSync(
    join(dir, 'req.http.yaml'),
    `name: Req\nmethod: GET\nurl: '{{BASE}}/'\npreRequestScript: |\n  ${indent(pre)}\ntestScript: |\n  ${indent(test)}\n`,
    'utf-8'
  );
  return dir;
}

const RUN = { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true } as const;

describe('script console output', () => {
  it('is surfaced on the result, pre-request first', async () => {
    const dir = makeCollection(`console.log('before send');`, `console.warn('after', 200);`);
    const result = await runCollection(dir, RUN, new NoopReporter());
    expect(result.requests[0]?.consoleLogs).toEqual([
      { phase: 'pre-request', type: 'log', message: 'before send' },
      { phase: 'test', type: 'warn', message: 'after 200' },
    ]);
  });

  it('is absent when scripts log nothing (pm.test lines are reported as assertions)', async () => {
    const dir = makeCollection(
      `pm.variables.set('a', '1');`,
      `pm.test('ok', () => {});\npm.test('bad', () => { throw new Error('nope'); });`
    );
    const result = await runCollection(dir, RUN, new NoopReporter());
    expect(result.requests[0]).not.toHaveProperty('consoleLogs');
  });

  it('is printed by the live reporter to stderr with control characters stripped', async () => {
    const dir = makeCollection(
      `console.log('plain');`,
      `console.error('\\u001b[2Jcleared\\u0007 screen\\nsecond line');`
    );
    const stderr: string[] = [];
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await runCollection(dir, RUN, new LiveReporter());
    } finally {
      write.mockRestore();
      log.mockRestore();
    }
    const lines = stderr.filter((l) => l.startsWith('    ['));
    expect(lines).toEqual([
      '    [pre-request log] plain\n',
      '    [test error] cleared screen\n',
      '    [test error] second line\n',
    ]);
  });

  it('is scrubbed by the shared redactor in file reports', async () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXNlY3JldA';
    const dir = makeCollection(`console.log('Authorization: Bearer ${token}');`, '');
    const result = await runCollection(dir, RUN, new NoopReporter());
    const reported = JSON.stringify(redactRunResult(result));
    expect(reported).toContain('consoleLogs');
    expect(reported).not.toContain(token);
  });
});
