import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Reporter, RunResult } from '../../reporters/types';
import { runCollection } from '../runner';

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

function makeCollection(
  reqs: Array<{ file: string; name: string; testScript?: string; preRequestScript?: string }>
): string {
  const dir = mkdtempSync(join(tmpdir(), 'restura-flow-'));
  writeFileSync(
    join(dir, '_collection.yaml'),
    `name: Flow\nvariables:\n  - { key: BASE, value: ${baseUrl}, enabled: true }\n`,
    'utf-8'
  );
  for (const r of reqs) {
    let body = `name: ${r.name}\nmethod: GET\nurl: '{{BASE}}/x'\n`;
    if (r.preRequestScript) {
      body += `preRequestScript: |\n  ${r.preRequestScript.replace(/\n/g, '\n  ')}\n`;
    }
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

  // `indexByName` was a plain object: inherited names resolved to functions,
  // and requests with those names could never be jump targets.
  it.each(['constructor', 'toString', 'hasOwnProperty'])(
    'reports setNextRequest(%j) as an unknown target when nothing has that name',
    async (target) => {
      const dir = makeCollection([
        { file: 'a.http.yaml', name: 'A', testScript: `pm.execution.setNextRequest('${target}');` },
        { file: 'b.http.yaml', name: 'B' },
      ]);
      const result = await runCollection(dir, RUN_OPTS, new NoopReporter());
      expect(names(result)).toEqual(['A', 'A']);
      expect(result.requests[1]?.errorMessage).toBe(
        `pm.execution.setNextRequest("${target}"): no runnable with that name`
      );
    }
  );

  it('jumps to a request actually named constructor', async () => {
    const dir = makeCollection([
      { file: 'a.http.yaml', name: 'A', testScript: `pm.execution.setNextRequest('constructor');` },
      { file: 'b.http.yaml', name: 'B' },
      { file: 'c.http.yaml', name: 'constructor' },
    ]);
    const result = await runCollection(dir, RUN_OPTS, new NoopReporter());
    expect(names(result)).toEqual(['A', 'constructor']);
  });
});

describe('runCollection — setNextRequest during pm.execution.skipRequest', () => {
  const skipThenJump = (target: string) =>
    `pm.execution.skipRequest();\npm.execution.setNextRequest('${target}');`;

  it('jumps by name from a skipped request', async () => {
    const dir = makeCollection([
      { file: 'a.http.yaml', name: 'A', preRequestScript: skipThenJump('C') },
      { file: 'b.http.yaml', name: 'B' },
      { file: 'c.http.yaml', name: 'C' },
    ]);
    const result = await runCollection(dir, RUN_OPTS, new NoopReporter());
    expect(names(result)).toEqual(['A', 'C']);
    expect(result.requests[0]?.skipped).toBe(true);
  });

  // Pinned CLI behaviour: on the skip path an unknown name is not an error, it
  // advances linearly. The sent path reports it instead.
  it('advances linearly without an error row when the target is unknown', async () => {
    const dir = makeCollection([
      { file: 'a.http.yaml', name: 'A', preRequestScript: skipThenJump('Nope') },
      { file: 'b.http.yaml', name: 'B' },
    ]);
    const result = await runCollection(dir, RUN_OPTS, new NoopReporter());
    expect(names(result)).toEqual(['A', 'B']);
    expect(result.requests.every((r) => r.errorMessage === undefined)).toBe(true);
  });

  it.each(['constructor', 'toString'])(
    'treats inherited name %j as an unknown target, not an iteration end',
    async (target) => {
      const dir = makeCollection([
        { file: 'a.http.yaml', name: 'A', preRequestScript: skipThenJump(target) },
        { file: 'b.http.yaml', name: 'B' },
      ]);
      const result = await runCollection(dir, RUN_OPTS, new NoopReporter());
      expect(names(result)).toEqual(['A', 'B']);
    }
  );

  it('jumps from a skipped request to a request actually named constructor', async () => {
    const dir = makeCollection([
      { file: 'a.http.yaml', name: 'A', preRequestScript: skipThenJump('constructor') },
      { file: 'b.http.yaml', name: 'B' },
      { file: 'c.http.yaml', name: 'constructor' },
    ]);
    const result = await runCollection(dir, RUN_OPTS, new NoopReporter());
    expect(names(result)).toEqual(['A', 'constructor']);
  });
});

// Host wiring the sequencer table test cannot see. Each pins today's CLI
// behaviour; the app's differing behaviour is pinned in setNextRequest.test.ts.
describe('runCollection — CLI sequencing pins', () => {
  it('--bail stops the run on an unknown setNextRequest target', async () => {
    const dir = makeCollection([
      { file: 'a.http.yaml', name: 'A', testScript: `pm.execution.setNextRequest('Nope');` },
    ]);
    const result = await runCollection(
      dir,
      { ...RUN_OPTS, bail: true, iterations: [{ row: '1' }, { row: '2' }] },
      new NoopReporter()
    );
    expect(result.requests.map((r) => [r.iteration, r.passed])).toEqual([
      [0, true],
      [0, false],
    ]);
  });

  it('without --bail an unknown setNextRequest target fails a row and the next row still runs', async () => {
    const dir = makeCollection([
      { file: 'a.http.yaml', name: 'A', testScript: `pm.execution.setNextRequest('Nope');` },
    ]);
    const result = await runCollection(
      dir,
      { ...RUN_OPTS, iterations: [{ row: '1' }, { row: '2' }] },
      new NoopReporter()
    );
    expect(result.requests.map((r) => [r.iteration, r.passed])).toEqual([
      [0, true],
      [0, false],
      [1, true],
      [1, false],
    ]);
  });

  it('--bail stays silent on an unknown target from a skipped request', async () => {
    const dir = makeCollection([
      {
        file: 'a.http.yaml',
        name: 'A',
        preRequestScript: `pm.execution.skipRequest();\npm.execution.setNextRequest('Nope');`,
      },
      { file: 'b.http.yaml', name: 'B' },
    ]);
    const result = await runCollection(dir, { ...RUN_OPTS, bail: true }, new NoopReporter());
    expect(names(result)).toEqual(['A', 'B']);
  });

  it('--bail stops on a blocked request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'restura-flow-'));
    const file = join(dir, 'c.postman_collection.json');
    writeFileSync(
      file,
      JSON.stringify({
        info: {
          name: 'P',
          schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
        },
        item: [
          {
            name: 'Blocked',
            request: {
              method: 'GET',
              url: `${baseUrl}/blocked`,
              auth: { type: 'hawk', hawk: [{ key: 'authId', value: 'id' }] },
            },
          },
          { name: 'After', request: { method: 'GET', url: `${baseUrl}/after` } },
        ],
      })
    );
    const result = await runCollection(file, { ...RUN_OPTS, bail: true }, new NoopReporter());
    expect(names(result)).toEqual(['Blocked']);
    expect(result.requests[0]).toMatchObject({ passed: false, notSent: true });
  });

  it('--delay-request waits only between requests, not before the first or after the last', async () => {
    const dir = makeCollection([{ file: 'a.http.yaml', name: 'A' }]);
    const started = Date.now();
    await runCollection(dir, { ...RUN_OPTS, delayRequestMs: 2000 }, new NoopReporter());
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
