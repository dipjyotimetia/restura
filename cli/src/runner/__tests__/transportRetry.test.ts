import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as createNetServer } from 'node:net';
import type { AuthConfig, GrpcRequest, HttpRequest, McpRequest, SseRequest } from '@shared/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoadedRequest } from '../collectionLoader';
import { executeGrpc } from '../executors/grpc';
import { executeHttp } from '../executors/http';
import { executeMcp } from '../executors/mcp';
import { executeSse } from '../executors/sse';
import type { ExecuteOptions, ExecuteOutcome, Executor } from '../executors/types';
import { type RetryOptions, withRetry } from '../retry';

/**
 * `--retry-on network` keys on `transportError`, which every executor sets
 * when no upstream response was received — and only then. Driven against real
 * sockets: a closed port (nothing answers) and a live server that answers.
 */

const PROTO = `syntax = "proto3";
package echo;
message EchoRequest { string text = 1; }
service EchoService { rpc Echo(EchoRequest) returns (EchoRequest); }
`;

let closedBase: string;
let liveBase: string;
let live: Server;

async function closedPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

beforeAll(async () => {
  closedBase = `http://127.0.0.1:${await closedPort()}`;
  live = createHttpServer((req, res) => {
    const path = req.url ?? '';
    if (path.startsWith('/oversize-grpc-web')) {
      // Declares more than the CLI's response cap: refused before reading.
      res.writeHead(200, {
        'content-type': 'application/grpc-web+proto',
        'content-length': String(1024 * 1024 * 1024),
      });
      res.flushHeaders();
      return;
    }
    if (path.startsWith('/oversize')) {
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(1024 * 1024 * 1024),
      });
      res.flushHeaders();
      return;
    }
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('busy');
  });
  await new Promise<void>((resolve) => live.listen(0, '127.0.0.1', resolve));
  liveBase = `http://127.0.0.1:${(live.address() as AddressInfo).port}`;
});

afterAll(async () => {
  live.closeAllConnections();
  await new Promise<void>((resolve) => live.close(() => resolve()));
});

const opts: ExecuteOptions = {
  vars: {},
  timeoutMs: 3000,
  allowLocalhost: true,
  sseDurationMs: 2000,
};

async function attempts(
  execute: Executor,
  item: LoadedRequest,
  retryOn: RetryOptions['retryOn'],
  options: ExecuteOptions = opts
): Promise<{ calls: number; outcome: ExecuteOutcome }> {
  let calls = 0;
  const outcome = await withRetry(
    () => {
      calls++;
      return execute(item, options);
    },
    { retries: 2, retryOn, baseDelayMs: 1 }
  );
  return { calls, outcome };
}

function http(url: string, extra: Partial<HttpRequest> = {}): LoadedRequest {
  const request: HttpRequest = {
    id: 'h',
    name: 'h',
    type: 'http',
    method: 'GET',
    url,
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    ...extra,
  };
  return { relativePath: 'h', folderPath: [], type: 'http', request };
}

function grpc(url: string, extra: Partial<GrpcRequest> = {}): LoadedRequest {
  const request: GrpcRequest = {
    id: 'g',
    name: 'g',
    type: 'grpc',
    methodType: 'unary',
    url,
    service: 'echo.EchoService',
    method: 'Echo',
    metadata: [],
    message: '{"text":"hi"}',
    auth: { type: 'none' },
    schema: { kind: 'proto', fileName: 'echo.proto', text: PROTO },
    ...extra,
  };
  return { relativePath: 'g', folderPath: [], type: 'grpc', request };
}

function sse(url: string, auth: AuthConfig = { type: 'none' }): LoadedRequest {
  const request: SseRequest = {
    id: 's',
    name: 's',
    type: 'sse',
    url,
    headers: [],
    params: [],
    auth,
  };
  return { relativePath: 's', folderPath: [], type: 'sse', request };
}

function mcp(
  url: string,
  transport: McpRequest['transport'],
  auth: AuthConfig = { type: 'none' }
): LoadedRequest {
  const request: McpRequest = {
    id: 'm',
    name: 'm',
    type: 'mcp',
    url,
    transport,
    headers: [],
    auth,
    defaultMethod: 'tools/list',
  };
  return { relativePath: 'm', folderPath: [], type: 'mcp', request };
}

describe('--retry-on network retries a real transport failure (closed port)', () => {
  it.each<[string, Executor, () => LoadedRequest]>([
    ['HTTP', executeHttp, () => http(`${closedBase}/x`)],
    [
      'GraphQL',
      executeHttp,
      () =>
        http(`${closedBase}/graphql`, { method: 'POST', body: { type: 'graphql', raw: '{ a }' } }),
    ],
    ['gRPC (Connect)', executeGrpc, () => grpc(closedBase)],
    ['gRPC-Web', executeGrpc, () => grpc(closedBase, { wireProtocol: 'grpc-web' })],
    ['SSE', executeSse, () => sse(`${closedBase}/events`)],
    ['MCP streamable-http', executeMcp, () => mcp(`${closedBase}/mcp`, 'streamable-http')],
    ['MCP http-sse', executeMcp, () => mcp(`${closedBase}/sse`, 'http-sse')],
  ])('%s: 3 attempts, marked transportError', async (_label, execute, item) => {
    const { calls, outcome } = await attempts(execute, item(), ['network']);
    expect(outcome.passed).toBe(false);
    expect(outcome.transportError).toBe(true);
    expect(outcome.refused).toBeUndefined();
    expect(calls).toBe(3);
  });
});

describe('network never matches an upstream answer or a refusal', () => {
  it('an upstream 503 is an answer: no retry under network, retried under 5xx', async () => {
    const network = await attempts(executeHttp, http(`${liveBase}/busy`), ['network']);
    expect(network.outcome.status).toBe(503);
    expect(network.outcome.transportError).toBeUndefined();
    expect(network.calls).toBe(1);
    expect((await attempts(executeHttp, http(`${liveBase}/busy`), ['5xx'])).calls).toBe(3);
  });

  it('an SSE upstream 503 is an answer', async () => {
    const { calls, outcome } = await attempts(executeSse, sse(`${liveBase}/busy`), ['network']);
    expect(outcome.status).toBe(503);
    expect(outcome.transportError).toBeUndefined();
    expect(calls).toBe(1);
  });

  const everyRule: RetryOptions['retryOn'] = ['network', '5xx', '4xx', 0, 400, 500];

  it('an SSRF-blocked URL is a refusal (HTTP and gRPC)', async () => {
    const guarded: ExecuteOptions = { ...opts, allowLocalhost: false };
    for (const [execute, item] of [
      [executeHttp, http(`${liveBase}/x`)],
      [executeGrpc, grpc(liveBase)],
    ] as const) {
      const { calls, outcome } = await attempts(execute, item, everyRule, guarded);
      expect(outcome.refused).toBe(true);
      expect(outcome.errorMessage).toMatch(/Invalid URL/);
      expect(calls).toBe(1);
    }
  });

  it.each<[string, AuthConfig]>([
    [
      'a desktop secret handle',
      { type: 'bearer', bearer: { token: { kind: 'handle', id: 'h1' } } },
    ],
    [
      'an external ref with no resolver',
      {
        type: 'bearer',
        bearer: {
          token: {
            kind: 'external',
            provider: 'aws-secrets-manager',
            profileId: 'p',
            secretId: 's',
          },
        },
      },
    ],
  ])('%s is a refusal in every executor', async (_label, auth) => {
    for (const [execute, item] of [
      [executeHttp, http(`${closedBase}/x`, { auth })],
      [executeGrpc, grpc(closedBase, { auth })],
      [executeSse, sse(`${closedBase}/events`, auth)],
      [executeMcp, mcp(`${closedBase}/mcp`, 'streamable-http', auth)],
    ] as const) {
      const { calls, outcome } = await attempts(execute, item, everyRule);
      expect(outcome.refused).toBe(true);
      expect(outcome.transportError).toBeUndefined();
      expect(calls).toBe(1);
    }
  });

  it.each([
    ['Connect', undefined],
    ['gRPC-Web', 'grpc-web'],
  ] as const)(
    'the CLI response-size cap (%s RESOURCE_EXHAUSTED) is not retried',
    async (_l, wire) => {
      const path = wire ? '/oversize-grpc-web' : '/oversize';
      const item = grpc(`${liveBase}${path}`, wire ? { wireProtocol: wire } : {});
      const { calls, outcome } = await attempts(executeGrpc, item, ['network', '5xx']);
      expect(outcome.grpcStatus?.code).toBe(8);
      expect(outcome.refused).toBe(true);
      expect(calls).toBe(1);
    }
  );
});
