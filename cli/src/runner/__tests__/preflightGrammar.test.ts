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

/**
 * Postman v2.1: `type: secret` loads value-less, as a secret variable (the same
 * rule as OpenCollection secret variables): checked per request at send time,
 * so `--data`, `--env` or an earlier script can supply it.
 */
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

const run = (
  file: string,
  reporter: Reporter,
  envVars: Record<string, string> = {},
  iterations?: Array<Record<string, string>>
) =>
  runCollection(
    file,
    {
      envVars,
      bail: false,
      timeoutMs: 5000,
      allowLocalhost: true,
      ...(iterations ? { iterations } : {}),
    },
    reporter
  );

describe('CLI preflight reads the shared token grammar', () => {
  const REFUSED: ReadonlyArray<[token: string, message: string]> = [
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

  for (const token of ['{{my private}}', '{{ my private }}']) {
    it(`reports request 2 using an unsupplied Postman secret ${token} as not sent; request 1 still runs`, async () => {
      const reporter = new RecordingReporter();
      const result = await run(postman(`v ${token}`), reporter);
      expect(hits).toEqual(['/one']);
      const second = result.requests[1];
      expect(second?.notSent).toBe(true);
      expect(second?.errorMessage).toContain('secret variable "my private" has no value');
    });
  }

  it('sends the spaced secret variable when the run supplies it', async () => {
    const reporter = new RecordingReporter();
    const result = await run(postman('{{my private}}'), reporter, { 'my private': 'v' });
    expect(result.summary.passed).toBe(2);
    expect(hits).toEqual(['/one', '/two']);
  });

  it('runs a Postman secret variable supplied by an iteration data row (B20)', async () => {
    const reporter = new RecordingReporter();
    const result = await run(postman('{{my private}}'), reporter, {}, [{ 'my private': 'row' }]);
    expect(result.summary.passed).toBe(2);
    expect(hits).toEqual(['/one', '/two']);
  });

  it('does not take a dynamic or an unknown token for a refusal', async () => {
    const reporter = new RecordingReporter();
    const result = await run(postman('{{$randomUUID}} {{some other}}'), reporter);
    expect(result.summary.passed).toBe(2);
  });
});
