import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderJUnitXml } from '../../reporters/junit';
import type { Reporter, RequestRunResult } from '../../reporters/types';
import { executeSse } from '../executors/sse';
import { runCollection } from '../runner';

let server: Server;
let baseUrl: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/sse-trailing') {
      // Two complete events, then an event with no terminating blank line.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: one\n\ndata: two\n\ndata: unterminated');
      return;
    }
    res.statusCode = 200;
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function makeCollection(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'restura-reporting-'));
  writeFileSync(
    join(dir, '_collection.yaml'),
    `name: Rep\nvariables:\n  - { key: BASE, value: ${baseUrl}, enabled: true }\n`
  );
  for (const [n, b] of Object.entries(files)) writeFileSync(join(dir, n), b);
  return dir;
}
const opts = { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true };

describe('assertion failures are failures, not errors', () => {
  it('counts a failed pm.test as failed (not errored) and renders <failure>', async () => {
    const dir = makeCollection({
      'a.http.yaml':
        `name: A\nmethod: GET\nurl: '{{BASE}}/'\n` +
        `testScript: |\n  pm.test('nope', () => pm.expect(1).to.equal(2));\n`,
    });
    const live: RequestRunResult[] = [];
    const reporter: Reporter = {
      onRequestComplete: (r) => {
        live.push(r);
      },
      onEnd: () => {},
    };
    const result = await runCollection(dir, opts, reporter);
    expect(result.summary).toMatchObject({ total: 1, passed: 0, failed: 1, errored: 0 });
    expect(live[0]?.errorMessage).toBeUndefined();
    const xml = renderJUnitXml(result);
    expect(xml).toContain('<failure');
    expect(xml).not.toContain('<error');
  });

  it('still reports a thrown script error as an error', async () => {
    const dir = makeCollection({
      'a.http.yaml':
        `name: A\nmethod: GET\nurl: '{{BASE}}/'\n` +
        `testScript: |\n  throw new Error('kaboom');\n`,
    });
    const result = await runCollection(dir, opts, { onEnd: () => {} });
    expect(result.summary).toMatchObject({ failed: 0, errored: 1 });
    expect(result.requests[0]?.passed).toBe(false);
  });
});

describe('failure labels', () => {
  it('does not call a direct connection failure a proxy failure when no proxy is set', async () => {
    const dir = makeCollection({
      'a.http.yaml': `name: Dead\nmethod: GET\nurl: 'http://127.0.0.1:1/ping'\n`,
    });
    const result = await runCollection(dir, opts, { onEnd: () => {} });
    const msg = result.requests[0]?.errorMessage ?? '';
    expect(msg).toMatch(/ECONNREFUSED/);
    expect(msg).not.toMatch(/proxy/i);
  });
});

describe('a bad setNextRequest name is reported live as well as in the summary', () => {
  it('calls onRequestComplete for the flow error row', async () => {
    const dir = makeCollection({
      'a.http.yaml':
        `name: A\nmethod: GET\nurl: '{{BASE}}/'\n` +
        `testScript: |\n  pm.execution.setNextRequest('No Such Request');\n`,
      'b.http.yaml': `name: B\nmethod: GET\nurl: '{{BASE}}/'\n`,
    });
    const live: RequestRunResult[] = [];
    const result = await runCollection(dir, opts, {
      onRequestComplete: (r) => {
        live.push(r);
      },
      onEnd: () => {},
    });
    expect(live.length).toBe(result.requests.length);
    expect(live.length).toBe(result.summary.total);
    expect(result.requests.some((r) => /No Such Request/.test(r.errorMessage ?? ''))).toBe(true);
  });
});

describe('SSE end of stream', () => {
  const sseItem = (url: string) =>
    ({
      relativePath: 'sse',
      folderPath: [],
      type: 'sse',
      request: {
        id: 's',
        name: 'S',
        type: 'sse',
        url,
        headers: [],
        params: [],
        auth: { type: 'none' },
      },
    }) as never;

  it('drops an unterminated trailing event (WHATWG; the app does the same)', async () => {
    const outcome = await executeSse(sseItem(`${baseUrl}/sse-trailing`), {
      vars: {},
      timeoutMs: 5000,
      allowLocalhost: true,
      sseDurationMs: 2000,
    });
    expect(outcome.streamEvents?.map((e) => e.data)).toEqual(['one', 'two']);
  });

  it('never exceeds --sse-events because of a trailing flush', async () => {
    const outcome = await executeSse(sseItem(`${baseUrl}/sse-trailing`), {
      vars: {},
      timeoutMs: 5000,
      allowLocalhost: true,
      sseDurationMs: 2000,
      sseMaxEvents: 2,
    });
    expect(outcome.streamEvents).toHaveLength(2);
  });
});
