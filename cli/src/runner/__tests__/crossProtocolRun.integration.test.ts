import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { internalToOC } from '@shared/opencollection/from-internal';
import { serializeOpenCollectionYAML } from '@shared/opencollection/serializer';
import type {
  Collection,
  CollectionItem,
  GrpcRequest,
  HttpRequest,
  McpRequest,
  SseRequest,
} from '@shared/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockGrpcServerHandle, startMockGrpcServer } from '../../../../e2e/mocks/grpcServer';
import {
  type MockMcpV2ServerHandle,
  startMockMcpV2Server,
} from '../../../../e2e/mocks/mcpV2Server';
import type { Reporter, RequestRunResult, RunResult } from '../../reporters/types';
import { runCollection } from '../runner';

/**
 * One Collection, five protocols, real servers, no mocked executors:
 *
 *   Auth/Login (HTTP)  -> pm.collectionVariables.set('token')
 *   API (folder: bearer {{token}}, var tenant)
 *     GraphQL/Me       -> envelope + inherited bearer; sets pm.variables 'me'
 *     Echo (gRPC)      -> {{me}} in the message, {{tenant}} as metadata
 *     Tool (MCP)       -> tools/call with {{me}} in the arguments
 *     Events (SSE)     -> inherited bearer, events reach the result
 *   Cleanup (HTTP)     -> skipRequest() on the second data row
 *
 * Driven by two data rows, so the chain must work per iteration with the
 * row's own user, and the token must be re-fetched (not leaked) per row.
 */

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  body: string;
}

let http: Server;
let httpUrl: string;
const seen: Seen[] = [];
let grpc: MockGrpcServerHandle;
let mcp: MockMcpV2ServerHandle;
let tmp: string;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

beforeAll(async () => {
  http = createServer(async (req, res) => {
    const body = await readBody(req);
    const url = req.url ?? '/';
    const auth = req.headers.authorization;
    seen.push({ method: req.method ?? '', url, auth, body });
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (url === '/login') {
      const user = (JSON.parse(body || '{}') as { user?: string }).user ?? 'anon';
      return json(200, { token: `tok-${user}` });
    }
    if (url === '/graphql') {
      const env = JSON.parse(body || '{}') as { query?: string };
      if (typeof env.query !== 'string') return json(400, { errors: [{ message: 'no query' }] });
      if (!auth?.startsWith('Bearer tok-')) return json(401, { errors: [{ message: 'unauth' }] });
      return json(200, { data: { me: auth.slice('Bearer tok-'.length) } });
    }
    if (url.startsWith('/events')) {
      if (!auth?.startsWith('Bearer tok-')) return json(401, {});
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: hello\ndata: ${auth.slice('Bearer '.length)}\n\n`);
      res.write('event: hello\ndata: second\n\n');
      return; // keep open: the run's --sse-max-events ends it
    }
    if (url.split('?')[0] === '/cleanup') return json(200, { ok: true });
    json(404, {});
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  httpUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  grpc = await startMockGrpcServer();
  mcp = await startMockMcpV2Server();
  tmp = await mkdtemp(join(tmpdir(), 'restura-cli-xproto-'));
});

afterAll(async () => {
  http.closeAllConnections();
  await new Promise<void>((r) => http.close(() => r()));
  await grpc?.close();
  await mcp?.close();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

const req = (item: HttpRequest | GrpcRequest | McpRequest | SseRequest): CollectionItem => ({
  id: item.id,
  name: item.name,
  type: 'request',
  request: item,
});

function buildCollection(): Collection {
  const login: HttpRequest = {
    id: 'login',
    name: 'Login',
    type: 'http',
    method: 'POST',
    url: '{{baseUrl}}/login',
    headers: [],
    params: [],
    body: { type: 'json', raw: '{"user":"{{user}}"}' },
    auth: { type: 'none' },
    testScript: [
      "pm.collectionVariables.set('token', pm.response.json().token);",
      "pm.test('login 200', () => pm.response.to.have.status(200));",
    ].join('\n'),
  };
  const me: HttpRequest = {
    id: 'me',
    name: 'Me',
    type: 'http',
    method: 'POST',
    url: '{{baseUrl}}/graphql',
    headers: [],
    params: [],
    body: { type: 'graphql', raw: 'query Me { me }' },
    auth: { type: 'none' },
    testScript: [
      "pm.variables.set('me', pm.response.json().data.me);",
      "pm.test('me is the row user', () => pm.expect(pm.response.json().data.me).to.equal(pm.iterationData.get('user')));",
    ].join('\n'),
  };
  const echo: GrpcRequest = {
    id: 'echo',
    name: 'Echo',
    type: 'grpc',
    methodType: 'unary',
    url: '{{grpcUrl}}',
    service: 'echo.v1.EchoService',
    method: 'UnaryEcho',
    metadata: [{ id: 'm1', key: 'x-echo-tenant', value: '{{tenant}}', enabled: true }],
    message: '{"message":"{{me}}"}',
    auth: { type: 'none' },
    testScript: [
      "pm.test('echoed the chained user', () => pm.expect(pm.response.json().message).to.equal('echo: ' + pm.variables.get('me')));",
      "pm.test('tenant metadata round-tripped', () => pm.expect(pm.response.headers.get('x-echo-tenant')).to.equal('acme'));",
    ].join('\n'),
  };
  const tool: McpRequest = {
    id: 'tool',
    name: 'Tool',
    type: 'mcp',
    url: '{{mcpUrl}}',
    transport: 'streamable-http',
    headers: [],
    auth: { type: 'none' },
    defaultMethod: 'tools/call',
    defaultParams: JSON.stringify({ name: 'echo', arguments: { text: '{{me}}' } }),
    testScript:
      "pm.test('tool echoed the user', () => pm.expect(JSON.stringify(pm.response.json())).to.include(pm.variables.get('me')));",
  };
  const events: SseRequest = {
    id: 'events',
    name: 'Events',
    type: 'sse',
    url: '{{baseUrl}}/events',
    headers: [],
    params: [],
    auth: { type: 'none' },
  };
  const cleanup: HttpRequest = {
    id: 'cleanup',
    name: 'Cleanup',
    type: 'http',
    method: 'DELETE',
    url: '{{baseUrl}}/cleanup',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    preRequestScript: "if (pm.iterationData.get('user') === 'bob') pm.execution.skipRequest();",
  };
  return {
    id: 'xproto',
    name: 'Cross protocol',
    items: [
      { id: 'f-auth', name: 'Auth', type: 'folder', items: [req(login)] },
      {
        id: 'f-api',
        name: 'API',
        type: 'folder',
        auth: { type: 'bearer', bearer: { token: '{{token}}' } },
        variables: [{ id: 'v1', key: 'tenant', value: 'acme', enabled: true }],
        items: [
          { id: 'f-gql', name: 'GraphQL', type: 'folder', items: [req(me)] },
          req(echo),
          // OpenCollection carries SSE and MCP items as `x-restura-*` extension
          // lists that re-attach at the end of their folder (SSE list first),
          // so this is the only sibling order that survives the round trip.
          req(events),
          req(tool),
        ],
      },
      req(cleanup),
    ],
  } as Collection;
}

class Recorder implements Reporter {
  results: RequestRunResult[] = [];
  final: RunResult | undefined;
  onRequestComplete(r: RequestRunResult) {
    this.results.push(r);
  }
  onEnd(r: RunResult) {
    this.final = r;
  }
}

describe('CLI cross-protocol collection run (real servers)', () => {
  it('chains a token and a value through HTTP, GraphQL, gRPC, MCP and SSE per data row', async () => {
    const file = join(tmp, 'collection.yml');
    await writeFile(file, serializeOpenCollectionYAML(internalToOC(buildCollection())), 'utf-8');

    const reporter = new Recorder();
    const result = await runCollection(
      file,
      {
        envVars: { baseUrl: httpUrl, grpcUrl: grpc.url, mcpUrl: mcp.url },
        bail: false,
        timeoutMs: 10_000,
        allowLocalhost: true,
        iterations: [{ user: 'alice' }, { user: 'bob' }],
        sseDurationMs: 3000,
        sseMaxEvents: 2,
      },
      reporter
    );

    const rows = result.requests.map((r) => ({
      name: r.request.request.name,
      iteration: r.iteration,
      passed: r.passed,
      skipped: r.skipped ?? false,
      error: r.errorMessage,
      failedAssertions: (r.assertions ?? []).filter((a) => !a.passed).map((a) => a.name),
    }));
    const expected = (iteration: number, user: string) => [
      {
        name: 'Login',
        iteration,
        passed: true,
        skipped: false,
        error: undefined,
        failedAssertions: [],
      },
      {
        name: 'Me',
        iteration,
        passed: true,
        skipped: false,
        error: undefined,
        failedAssertions: [],
      },
      {
        name: 'Echo',
        iteration,
        passed: true,
        skipped: false,
        error: undefined,
        failedAssertions: [],
      },
      {
        name: 'Events',
        iteration,
        passed: true,
        skipped: false,
        error: undefined,
        failedAssertions: [],
      },
      {
        name: 'Tool',
        iteration,
        passed: true,
        skipped: false,
        error: undefined,
        failedAssertions: [],
      },
      {
        name: 'Cleanup',
        iteration,
        passed: true,
        skipped: user === 'bob',
        error: undefined,
        failedAssertions: [],
      },
    ];
    expect(rows).toEqual([...expected(0, 'alice'), ...expected(1, 'bob')]);
    expect(result.summary).toMatchObject({
      total: 12,
      passed: 12,
      failed: 0,
      errored: 0,
      skipped: 1,
    });

    // GraphQL went out as an envelope with the folder's bearer, per row.
    const gql = seen.filter((s) => s.url === '/graphql');
    expect(gql.map((s) => s.auth)).toEqual(['Bearer tok-alice', 'Bearer tok-bob']);
    expect(JSON.parse(gql[0]?.body ?? '{}')).toMatchObject({ query: 'query Me { me }' });
    // SSE inherited the bearer; its events reached the result.
    const sse = result.requests.filter((r) => r.request.request.name === 'Events');
    expect(sse.map((r) => r.streamEvents?.[0]?.data)).toEqual(['tok-alice', 'tok-bob']);
    // The skipped Cleanup never reached the server.
    expect(seen.filter((s) => s.url === '/cleanup')).toHaveLength(1);
    // Five servers, two iterations: well past the 5s default on a loaded runner.
  }, 30_000);

  it('a secret collection variable never goes out empty: --env, a data row or a script supplies it, absent it fails that item', async () => {
    const collection: Collection = {
      id: 'sec',
      name: 'Secret',
      variables: [{ id: 'v', key: 'apiKey', value: '', enabled: true, secret: true } as never],
      items: [
        req({
          id: 'k',
          name: 'Keyed',
          type: 'http',
          method: 'GET',
          url: '{{baseUrl}}/cleanup?k={{apiKey}}',
          headers: [],
          params: [],
          body: { type: 'none' },
          auth: { type: 'none' },
        }),
      ],
    };
    const file = join(tmp, 'secret.yml');
    await writeFile(file, serializeOpenCollectionYAML(internalToOC(collection)), 'utf-8');

    seen.length = 0;
    const ok = await runCollection(
      file,
      {
        envVars: { baseUrl: httpUrl, apiKey: 'real' },
        bail: false,
        timeoutMs: 5000,
        allowLocalhost: true,
      },
      new Recorder()
    );
    expect(ok.summary.passed).toBe(1);
    expect(seen.at(-1)?.url).toBe('/cleanup?k=real');

    // A --data row supplies it.
    const fromRow = await runCollection(
      file,
      {
        envVars: { baseUrl: httpUrl },
        bail: false,
        timeoutMs: 5000,
        allowLocalhost: true,
        iterations: [{ apiKey: 'row' }],
      },
      new Recorder()
    );
    expect(fromRow.summary.passed).toBe(1);
    expect(seen.at(-1)?.url).toBe('/cleanup?k=row');

    // Nobody supplies it: that item is not sent and fails; the run still completes.
    const before = seen.length;
    const missing = await runCollection(
      file,
      { envVars: { baseUrl: httpUrl }, bail: false, timeoutMs: 5000, allowLocalhost: true },
      new Recorder()
    );
    expect(seen.length).toBe(before);
    expect(missing.requests[0]).toMatchObject({ passed: false, notSent: true });
    expect(missing.requests[0]?.errorMessage).toMatch(/secret variable "apiKey" has no value/);
  });

  it('a secret collection variable set by an earlier script chains like any other (login -> token)', async () => {
    const http = (id: string, name: string, url: string, testScript?: string) =>
      req({
        id,
        name,
        type: 'http',
        method: 'GET',
        url,
        headers: [],
        params: [],
        body: { type: 'none' },
        auth: { type: 'none' },
        ...(testScript ? { testScript } : {}),
      });
    const collection: Collection = {
      id: 'sec-chain',
      name: 'Secret chain',
      variables: [{ id: 'v', key: 'token', value: '', enabled: true, secret: true } as never],
      items: [
        http(
          'l',
          'Login',
          '{{baseUrl}}/cleanup?step=login',
          "pm.collectionVariables.set('token', 'from-script');"
        ),
        http('u', 'Use', '{{baseUrl}}/cleanup?t={{token}}'),
      ],
    };
    const file = join(tmp, 'secret-chain.yml');
    await writeFile(file, serializeOpenCollectionYAML(internalToOC(collection)), 'utf-8');
    seen.length = 0;
    const result = await runCollection(
      file,
      { envVars: { baseUrl: httpUrl }, bail: false, timeoutMs: 5000, allowLocalhost: true },
      new Recorder()
    );
    expect(result.summary.passed).toBe(2);
    expect(seen.map((s) => s.url)).toEqual(['/cleanup?step=login', '/cleanup?t=from-script']);
  });
});
