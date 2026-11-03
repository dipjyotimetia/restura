// Live-wire tests for the CLI gRPC executor: the real undici fetcher against
// real HTTP servers — a Connect server (connect-node), a native-gRPC-only
// server that refuses Connect, and a slow server for cancellation.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { create, type DescService } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { registryFromProtoText } from '@shared/protocol/grpc-registry';
import type { GrpcRequest } from '@shared/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoadedRequest } from '../collectionLoader';
import { executeGrpc } from '../executors/grpc';
import type { ExecuteOptions } from '../executors/types';

const PROTO = `syntax = "proto3";
package live.v1;
message Envelope { string note = 1; }
service Edge {
  rpc Wrap(Envelope) returns (Envelope);
  rpc get_item(Envelope) returns (Envelope);
  rpc Fail(Envelope) returns (Envelope);
}`;
const registry = registryFromProtoText(PROTO);
const EDGE = registry.getService('live.v1.Edge') as DescService;
const envelope = registry.getMessage('live.v1.Envelope')!;
const PREFIX = '/api/rpc';

let lastHeaders: IncomingMessage['headers'] = {};
const connectRoutes = (prefix?: string) =>
  connectNodeAdapter({
    ...(prefix ? { requestPathPrefix: prefix } : {}),
    routes(router) {
      router.service(EDGE, {
        wrap: (req: { note: string }) => create(envelope, { note: `echo ${req.note}` }),
        get_item: (req: { note: string }) => create(envelope, { note: `got ${req.note}` }),
        fail: () => {
          throw new ConnectError('order 42 is locked', Code.FailedPrecondition);
        },
      } as never);
    },
  });
const plain = connectRoutes();
const prefixed = connectRoutes(PREFIX);

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  return new Promise<{ server: Server; url: string }>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })
    )
  );
}

let connectServer: { server: Server; url: string };
let nativeOnly: { server: Server; url: string };
let slow: { server: Server; url: string };

beforeAll(async () => {
  connectServer = await listen((req, res) => {
    lastHeaders = req.headers;
    (String(req.url).startsWith(`${PREFIX}/`) ? prefixed : plain)(req, res);
  });
  // grpc-go answers a non-gRPC content type with HTTP 415 and a text body.
  nativeOnly = await listen((_req, res) => {
    res.writeHead(415, { 'content-type': 'text/plain' });
    res.end('invalid gRPC request content-type "application/json"');
  });
  slow = await listen((_req, res) => {
    setTimeout(() => {
      if (!res.destroyed) res.end('{}');
    }, 5_000);
  });
});
afterAll(async () => {
  for (const s of [connectServer, nativeOnly, slow]) {
    s.server.closeAllConnections();
    await new Promise<void>((r) => s.server.close(() => r()));
  }
});

const opts: ExecuteOptions = { vars: {}, timeoutMs: 5000, allowLocalhost: true };

function item(extra: Partial<GrpcRequest>): LoadedRequest {
  const request: GrpcRequest = {
    id: 'g1',
    name: 'Call',
    type: 'grpc',
    methodType: 'unary',
    url: connectServer.url,
    service: 'live.v1.Edge',
    method: 'Wrap',
    metadata: [],
    message: '{"note":"hi"}',
    auth: { type: 'none' },
    ...extra,
  };
  return { relativePath: 'a.grpc', folderPath: [], type: 'grpc', request };
}

describe('CLI gRPC over Connect (live)', () => {
  it('a unary call succeeds', async () => {
    const out = await executeGrpc(item({}), opts);
    expect(out.passed, out.errorMessage).toBe(true);
    expect(JSON.parse(out.responseBody ?? '{}')).toEqual({ note: 'echo hi' });
  });

  it('calls a non-PascalCase method', async () => {
    const out = await executeGrpc(item({ method: 'get_item' }), opts);
    expect(out.passed, out.errorMessage).toBe(true);
    expect(JSON.parse(out.responseBody ?? '{}')).toEqual({ note: 'got hi' });
  });

  it('keeps the URL path prefix', async () => {
    const out = await executeGrpc(item({ url: `${connectServer.url}${PREFIX}/` }), opts);
    expect(out.passed, out.errorMessage).toBe(true);
  });

  it('a server error reports the status AND the server message', async () => {
    const out = await executeGrpc(item({ method: 'Fail' }), opts);
    expect(out.passed).toBe(false);
    expect(out.grpcStatus?.code).toBe(Code.FailedPrecondition);
    expect(out.errorMessage).toBe('gRPC FAILED_PRECONDITION: order 42 is locked');
  });

  it('sends the deadline and base64-encodes text -bin metadata', async () => {
    await executeGrpc(
      item({
        timeout: 2500,
        metadata: [{ id: 'm', key: 'trace-bin', value: 'hello world', enabled: true }],
      }),
      opts
    );
    expect(lastHeaders['connect-timeout-ms']).toBe('2500');
    expect(lastHeaders['trace-bin']).toBe(Buffer.from('hello world').toString('base64'));
  });
});

describe('CLI auto mode against a native-gRPC-only server (live)', () => {
  it('fails explicitly, naming the Connect-only CLI behaviour', async () => {
    const out = await executeGrpc(item({ url: nativeOnly.url }), opts);
    expect(out.passed).toBe(false);
    expect(out.errorMessage).toMatch(/^gRPC UNKNOWN: HTTP 415/);
    expect(out.errorMessage).toContain('sends "auto" requests over the Connect protocol only');
  });

  it('a request pinned to Connect gets no auto-mode note', async () => {
    const out = await executeGrpc(item({ url: nativeOnly.url, wireProtocol: 'connect' }), opts);
    expect(out.passed).toBe(false);
    expect(out.errorMessage).not.toContain('"auto"');
  });
});

describe('CLI cancellation (live)', () => {
  it('an abort ends the Connect call as CANCELLED without waiting for the deadline', async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 50);
    const out = await executeGrpc(item({ url: slow.url, timeout: 10_000 }), {
      ...opts,
      signal: controller.signal,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(out.passed).toBe(false);
    expect(out.grpcStatus?.code).toBe(Code.Canceled);
  });
});
