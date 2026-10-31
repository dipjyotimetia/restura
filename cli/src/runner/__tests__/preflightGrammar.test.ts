import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Reporter, RequestRunResult, RunResult } from '../../reporters/types';
import { runCollection } from '../runner';

let server: Server;
let baseUrl: string;
const hits: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? '');
    res.statusCode = 200;
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  hits.length = 0;
});

class RecordingReporter implements Reporter {
  started = 0;
  completed: RequestRunResult[] = [];
  ended: RunResult | undefined;
  onRequestStart(): void {
    this.started++;
  }
  onRequestComplete(result: RequestRunResult): void {
    this.completed.push(result);
  }
  onEnd(result: RunResult): void {
    this.ended = result;
  }
}

/** Postman v2.1: `type: secret` loads value-less, as a private variable. */
function postman(secondValue: string, extraItems: unknown[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'restura-preflight-'));
  const file = join(dir, 'c.postman_collection.json');
  writeFileSync(
    file,
    JSON.stringify({
      info: {
        name: 'c',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      variable: [{ key: 'my private', type: 'secret' }],
      item: [
        { name: 'one', request: { method: 'GET', url: `${baseUrl}/one` } },
        {
          name: 'two',
          request: {
            method: 'GET',
            url: `${baseUrl}/two`,
            header: [{ key: 'X-K', value: secondValue }],
          },
        },
        ...extraItems,
      ],
    }),
    'utf-8'
  );
  return file;
}

const run = (file: string, reporter: Reporter, envVars: Record<string, string> = {}) =>
  runCollection(file, { envVars, bail: false, timeoutMs: 5000, allowLocalhost: true }, reporter);

describe('CLI preflight reads the shared token grammar', () => {
  const REFUSED: ReadonlyArray<[token: string, message: string]> = [
    ['{{my private}}', 'Private variable "my private" is unavailable'],
    ['{{ my private }}', 'Private variable "my private" is unavailable'],
    ['{{handle:a b}}', 'SecretRef handles are unavailable'],
    ['{{handle:x}}', 'SecretRef handles are unavailable'],
  ];
  for (const [token, message] of REFUSED) {
    it(`refuses ${token} in request 2 before request 1 goes out`, async () => {
      const reporter = new RecordingReporter();
      await expect(run(postman(`v ${token}`), reporter)).rejects.toThrow(message);
      expect(hits).toEqual([]);
      expect(reporter.started).toBe(0);
      expect(reporter.completed).toEqual([]);
    });
  }

  it('sends the spaced private variable when the run supplies it', async () => {
    const reporter = new RecordingReporter();
    const result = await run(postman('{{my private}}'), reporter, { 'my private': 'v' });
    expect(result.summary.passed).toBe(2);
    expect(hits).toEqual(['/one', '/two']);
  });

  it('does not take a dynamic or an unknown token for a refusal', async () => {
    const reporter = new RecordingReporter();
    const result = await run(postman('{{$randomUUID}} {{some other}}'), reporter);
    expect(result.summary.passed).toBe(2);
  });
});

describe('a refusal the preflight cannot see', () => {
  it('fails that item and keeps the run and its report', async () => {
    // The script writes a metadata value at run time, so nothing on disk holds it.
    const dir = mkdtempSync(join(tmpdir(), 'restura-preflight-'));
    writeFileSync(
      join(dir, '_collection.yaml'),
      `name: c\nvariables:\n  - { key: BASE, value: ${baseUrl}, enabled: true }\n`,
      'utf-8'
    );
    writeFileSync(
      join(dir, 'a.grpc.yaml'),
      [
        'name: grpc',
        'type: grpc',
        "url: '{{BASE}}/rpc'",
        'service: echo.Echo',
        'method: Echo',
        'methodType: unary',
        "message: '{}'",
        'preRequestScript: |',
        "  rs.request.metadata['x-k'] = '{{handle' + ':x}}';",
        '',
      ].join('\n'),
      'utf-8'
    );
    writeFileSync(
      join(dir, 'b.http.yaml'),
      `name: after\nmethod: GET\nurl: '{{BASE}}/after'\n`,
      'utf-8'
    );
    const reporter = new RecordingReporter();
    const result = await run(dir, reporter);
    expect(reporter.ended).toBeDefined();
    const names = result.requests.map((r) => r.request.request.name);
    expect(names).toContain('after');
    const failed = result.requests.find((r) => r.request.request.name === 'grpc');
    expect(failed?.passed).toBe(false);
    expect(failed?.errorMessage).toContain('SecretRef handles are unavailable');
    expect(hits).toContain('/after');
  });
});
