import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCollection } from '../runner';
import type { Reporter } from '../../reporters/types';

// ---------------------------------------------------------------------------
// Local HTTP server captures the wire-level Authorization / X-Amz-* / etc.
// headers each request sends, then echoes them back so the test can assert
// exact byte-level format. This is the contract the renderer relies on:
// the CLI must produce identical wire output for a given auth config.
// ---------------------------------------------------------------------------

interface CapturedRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
}

let server: Server;
let baseUrl: string;
let captured: CapturedRequest[];

beforeAll(async () => {
  captured = [];
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    captured.push({ path: req.url ?? '/', headers: req.headers });
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
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

function lastCapture(): CapturedRequest {
  return captured[captured.length - 1]!;
}

function authCollection(requestYaml: string, filename = 'a.http.yaml'): string {
  const dir = mkdtempSync(join(tmpdir(), 'restura-auth-'));
  writeFileSync(
    join(dir, '_collection.yaml'),
    `name: AuthTests\nvariables:\n  - { key: BASE, value: ${baseUrl}, enabled: true }\n`,
    'utf-8'
  );
  writeFileSync(join(dir, filename), requestYaml, 'utf-8');
  return dir;
}

describe('CLI auth signing — wire-level shapes', () => {
  it('Bearer auth sets `Authorization: Bearer <token>`', async () => {
    const dir = authCollection(
      `name: WithBearer\nmethod: GET\nurl: '{{BASE}}/x'\nauth:\n  type: bearer\n  bearer:\n    token: 'abc.def.ghi'\n`
    );
    await runCollection(
      dir,
      { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true },
      new NoopReporter()
    );
    expect(lastCapture().headers.authorization).toBe('Bearer abc.def.ghi');
  });

  it('Basic auth sets `Authorization: Basic <base64>`', async () => {
    const dir = authCollection(
      `name: WithBasic\nmethod: GET\nurl: '{{BASE}}/x'\nauth:\n  type: basic\n  basic:\n    username: alice\n    password: hunter2\n`
    );
    await runCollection(
      dir,
      { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true },
      new NoopReporter()
    );
    const expected = `Basic ${Buffer.from('alice:hunter2').toString('base64')}`;
    expect(lastCapture().headers.authorization).toBe(expected);
  });

  it('API-key auth in header sets the named header', async () => {
    const dir = authCollection(
      `name: ApiKeyHeader\nmethod: GET\nurl: '{{BASE}}/x'\nauth:\n  type: api-key\n  apiKey:\n    key: X-API-Key\n    value: secret123\n    in: header\n`
    );
    await runCollection(
      dir,
      { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true },
      new NoopReporter()
    );
    expect(lastCapture().headers['x-api-key']).toBe('secret123');
  });

  it('API-key auth in query sets the named query param', async () => {
    const dir = authCollection(
      `name: ApiKeyQuery\nmethod: GET\nurl: '{{BASE}}/x'\nauth:\n  type: api-key\n  apiKey:\n    key: api_key\n    value: secret456\n    in: query\n`
    );
    await runCollection(
      dir,
      { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true },
      new NoopReporter()
    );
    expect(lastCapture().path).toContain('api_key=secret456');
  });

  it('AWS Signature v4 sets an Authorization header with AWS4-HMAC-SHA256', async () => {
    const dir = authCollection(
      `name: AwsSig\nmethod: GET\nurl: '{{BASE}}/x'\nauth:\n  type: aws-signature\n  awsSignature:\n    accessKey: AKIAIOSFODNN7EXAMPLE\n    secretKey: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n    region: us-east-1\n    service: s3\n`
    );
    await runCollection(
      dir,
      { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true },
      new NoopReporter()
    );
    const authz = lastCapture().headers.authorization;
    expect(String(authz)).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request/
    );
    expect(String(authz)).toContain('Signature=');
    // Date header is mandatory for SigV4
    expect(lastCapture().headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
  });

  it('gRPC requests carry Bearer auth as metadata', async () => {
    const dir = authCollection(
      `name: GrpcAuth\nmethodType: unary\nurl: '{{BASE}}'\nservice: My.Service\nmethod: Echo\n` +
        `auth:\n  type: bearer\n  bearer:\n    token: 'grpc-tok'\n`,
      'a.grpc.yaml'
    );
    await runCollection(
      dir,
      { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true },
      new NoopReporter()
    );
    expect(lastCapture().headers.authorization).toBe('Bearer grpc-tok');
  });

  it('SSE requests carry Basic auth as a header', async () => {
    const dir = authCollection(
      `name: SseAuth\nurl: '{{BASE}}/stream'\n` +
        `auth:\n  type: basic\n  basic:\n    username: u\n    password: p\n`,
      'a.sse.yaml'
    );
    await runCollection(
      dir,
      { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true, sseDurationMs: 500 },
      new NoopReporter()
    );
    expect(lastCapture().headers.authorization).toBe(
      `Basic ${Buffer.from('u:p').toString('base64')}`
    );
  });

  it('MCP requests carry API-key auth as a header', async () => {
    const dir = authCollection(
      `name: McpAuth\nurl: '{{BASE}}/mcp'\ntransport: streamable-http\n` +
        `auth:\n  type: api-key\n  apiKey:\n    key: X-Mcp-Key\n    value: mcp-secret\n    in: header\n`,
      'a.mcp.yaml'
    );
    await runCollection(
      dir,
      { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true },
      new NoopReporter()
    );
    expect(lastCapture().headers['x-mcp-key']).toBe('mcp-secret');
  });

  it('an unresolvable secret-handle ref errors the request instead of sending it unauthenticated', async () => {
    const before = captured.length;
    const dir = authCollection(
      `name: Handle\nmethod: GET\nurl: '{{BASE}}/x'\n` +
        `auth:\n  type: bearer\n  bearer:\n    token: { kind: handle, id: 'abc-123' }\n`
    );
    const result = await runCollection(
      dir,
      { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true },
      new NoopReporter()
    );
    // The request must NOT have reached the server.
    expect(captured.length).toBe(before);
    expect(result.requests[0]?.passed).toBe(false);
    expect(result.requests[0]?.errorMessage).toMatch(/secret handle/i);
    expect(result.summary.errored).toBe(1);
  });
});
