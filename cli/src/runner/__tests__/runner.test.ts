import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCollection } from '../runner';
import type { Reporter, RunResult, RequestRunResult, RunMeta } from '../../reporters/types';
import type { LoadedRequest } from '../collectionLoader';

// ---------------------------------------------------------------------------
// Local HTTP server — mirrors undiciFetcher.test.ts pattern (real network hop
// keeps the executeHttpProxy + URL validation + sanitisation paths exercised).
// ---------------------------------------------------------------------------

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    if (url === '/ok') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    } else if (url === '/oops') {
      res.statusCode = 500;
      res.end('{"error":"boom"}');
    } else if (url === '/users/1') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('{"id":1}');
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

// ---------------------------------------------------------------------------
// Test reporter — records callback order so we can assert lifecycle.
// ---------------------------------------------------------------------------

class RecordingReporter implements Reporter {
  events: Array<
    | { kind: 'start'; meta: RunMeta }
    | { kind: 'requestStart'; name: string }
    | { kind: 'requestComplete'; name: string; passed: boolean; status: number }
    | { kind: 'end'; total: number; passed: number; failed: number; errored: number }
  > = [];

  onStart(meta: RunMeta): void {
    this.events.push({ kind: 'start', meta });
  }
  onRequestStart(request: LoadedRequest): void {
    this.events.push({ kind: 'requestStart', name: request.request.name });
  }
  onRequestComplete(result: RequestRunResult): void {
    this.events.push({
      kind: 'requestComplete',
      name: result.request.request.name,
      passed: result.passed,
      status: result.status,
    });
  }
  onEnd(result: RunResult): void {
    this.events.push({
      kind: 'end',
      total: result.summary.total,
      passed: result.summary.passed,
      failed: result.summary.failed,
      errored: result.summary.errored,
    });
  }
}

// ---------------------------------------------------------------------------
// Per-test temp fixture builder — keeps each test in its own collection dir.
// ---------------------------------------------------------------------------

interface RequestSpec {
  filename: string;
  body: string;
}

function makeCollection(name: string, requests: RequestSpec[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'restura-runner-'));
  writeFileSync(
    join(dir, '_collection.yaml'),
    `name: ${name}\nvariables:\n  - { key: BASE, value: ${baseUrl}, enabled: true }\n`,
    'utf-8'
  );
  for (const r of requests) {
    writeFileSync(join(dir, r.filename), r.body, 'utf-8');
  }
  return dir;
}

describe('runCollection', () => {
  it('runs a collection and reports passing/failing summary', async () => {
    const dir = makeCollection('Mixed', [
      {
        filename: 'a-good.http.yaml',
        body: `name: Good\nmethod: GET\nurl: '{{BASE}}/ok'\n`,
      },
      {
        filename: 'b-bad.http.yaml',
        body: `name: Bad\nmethod: GET\nurl: '{{BASE}}/oops'\n`,
      },
    ]);
    const reporter = new RecordingReporter();
    const result = await runCollection(
      dir,
      { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true },
      reporter
    );

    expect(result.summary.total).toBe(2);
    expect(result.summary.passed).toBe(1);
    expect(result.summary.failed).toBe(1);
    expect(result.summary.errored).toBe(0);
    expect(result.requests[0]?.passed).toBe(true);
    expect(result.requests[0]?.status).toBe(200);
    expect(result.requests[1]?.passed).toBe(false);
    expect(result.requests[1]?.status).toBe(500);
  });

  it('fires reporter callbacks in the correct order', async () => {
    const dir = makeCollection('Lifecycle', [
      {
        filename: 'one.http.yaml',
        body: `name: One\nmethod: GET\nurl: '{{BASE}}/ok'\n`,
      },
      {
        filename: 'two.http.yaml',
        body: `name: Two\nmethod: GET\nurl: '{{BASE}}/ok'\n`,
      },
    ]);
    const reporter = new RecordingReporter();
    await runCollection(
      dir,
      { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true },
      reporter
    );

    const kinds = reporter.events.map((e) => e.kind);
    expect(kinds).toEqual([
      'start',
      'requestStart',
      'requestComplete',
      'requestStart',
      'requestComplete',
      'end',
    ]);
  });

  it('--bail stops iteration after first non-pass', async () => {
    const dir = makeCollection('Bail', [
      {
        filename: 'a-bad.http.yaml',
        body: `name: Bad\nmethod: GET\nurl: '{{BASE}}/oops'\n`,
      },
      {
        filename: 'b-skipped.http.yaml',
        body: `name: Skipped\nmethod: GET\nurl: '{{BASE}}/ok'\n`,
      },
    ]);
    const reporter = new RecordingReporter();
    const result = await runCollection(
      dir,
      { envVars: {}, bail: true, timeoutMs: 5000, allowLocalhost: true },
      reporter
    );

    expect(result.summary.total).toBe(1);
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]?.request.request.name).toBe('Bad');
    expect(reporter.events.some((e) => e.kind === 'requestStart' && e.name === 'Skipped')).toBe(false);
  });

  it('captures network errors as errored results', async () => {
    // Closed port — undici should reject the connection.
    const dir = makeCollection('NetErr', [
      {
        filename: 'a-dead.http.yaml',
        // Use an explicit unreachable port; allowLocalhost lets it through validation
        body: `name: Dead\nmethod: GET\nurl: 'http://127.0.0.1:1/ping'\n`,
      },
    ]);
    const reporter = new RecordingReporter();
    const result = await runCollection(
      dir,
      { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true },
      reporter
    );

    expect(result.summary.total).toBe(1);
    expect(result.summary.errored).toBe(1);
    expect(result.summary.passed).toBe(0);
    expect(result.requests[0]?.passed).toBe(false);
    expect(result.requests[0]?.errorMessage).toBeDefined();
  });

  it('routes gRPC requests through the gRPC executor and surfaces gRPC status', async () => {
    // The local HTTP server returns 404 for unknown paths. Pointing a gRPC
    // request at it exercises the gRPC executor + Connect error mapping
    // without standing up a real gRPC server in this unit test.
    const dir = makeCollection('GrpcSmoke', [
      {
        filename: 'a-grpc.grpc.yaml',
        body: `name: Grpc\nmethodType: unary\nurl: '{{BASE}}'\nservice: My.Service\nmethod: Echo\n`,
      },
    ]);
    const reporter = new RecordingReporter();
    const result = await runCollection(
      dir,
      { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true },
      reporter
    );

    expect(result.summary.total).toBe(1);
    expect(result.requests[0]?.passed).toBe(false);
    // The 404 from the local HTTP server is reinterpreted as a gRPC UNKNOWN
    // status — confirms the executor ran and the shared proxy was reached.
    expect(result.requests[0]?.grpcStatus).toEqual({ code: 2, message: 'UNKNOWN' });
    expect(result.requests[0]?.errorMessage).toMatch(/gRPC UNKNOWN/);
  });

  it('resolves env vars and collection variables (env first, collection wins)', async () => {
    // Provide BASE via env vars too; the collection variable (already pointing at
    // the real server) should win — meaning the request hits the real server, not
    // the bogus env value.
    const dir = makeCollection('Vars', [
      {
        filename: 'a.http.yaml',
        body: `name: WithVar\nmethod: GET\nurl: '{{BASE}}/users/1'\n`,
      },
    ]);
    const reporter = new RecordingReporter();
    const result = await runCollection(
      dir,
      {
        envVars: { BASE: 'http://this-should-be-overridden.invalid' },
        bail: false,
        timeoutMs: 5000,
        allowLocalhost: true,
      },
      reporter
    );

    expect(result.summary.passed).toBe(1);
    expect(result.requests[0]?.status).toBe(200);
  });

  it('returns a runResult whose meta carries collection name + dir', async () => {
    const dir = makeCollection('NameMe', [
      {
        filename: 'a.http.yaml',
        body: `name: One\nmethod: GET\nurl: '{{BASE}}/ok'\n`,
      },
    ]);
    const reporter = new RecordingReporter();
    const result = await runCollection(
      dir,
      { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true },
      reporter
    );

    expect(result.meta.collectionName).toBe('NameMe');
    expect(result.meta.collectionDir).toBe(dir);
    expect(result.meta.startedAt).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// Silence unused import lint when test fixtures don't need a subdir.
void mkdirSync;
