// @vitest-environment node
// Live-wire tests for the desktop gRPC data plane: real connect-node transports
// (no injected router transports) against real HTTP/2 + HTTP/1.1 servers, so
// the native→Connect fallback, its per-origin memo, path prefixes and
// google.protobuf.Any are exercised exactly as the app runs them.
import { createServer as createHttp1Server, type Server } from 'node:http';
import {
  createServer as createH2cServer,
  type Http2Server,
  type Http2ServerRequest,
  type Http2ServerResponse,
  type ServerHttp2Session,
} from 'node:http2';
import type { AddressInfo } from 'node:net';
import { create, type DescService } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { registryFromProtoText } from '@shared/protocol/grpc-registry';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../security/secret-handle-store', () => ({
  unwrapSecretValueMain: (v: unknown) => (typeof v === 'string' ? v : undefined),
}));

import { executeConnectServerStreamCollect, executeConnectUnary } from '../handlers/grpc-connect';
import {
  isConnectPreferredForTests,
  resetProtocolFallbackStateForTests,
} from '../handlers/grpc-transport';

const PROTO = `syntax = "proto3";
package live.v1;
import "google/protobuf/any.proto";
message Inner { string x = 1; }
message Envelope { string note = 1; google.protobuf.Any payload = 2; }
service Edge {
  rpc Wrap(Envelope) returns (Envelope);
  rpc get_item(Envelope) returns (Envelope);
  rpc Fail(Envelope) returns (Envelope);
  rpc Many(Envelope) returns (stream Envelope);
}`;

const registry = registryFromProtoText(PROTO);
const EDGE = registry.getService('live.v1.Edge') as DescService;
const envelope = registry.getMessage('live.v1.Envelope')!;
const INNER_ANY = { '@type': 'type.googleapis.com/live.v1.Inner', x: 'hi' };

type Gate = 'open' | 'native-only' | 'connect-only' | 'http503' | 'refuse-all' | 'connect-hangs';

interface Seen {
  path: string;
  wire: 'grpc' | 'grpc-web' | 'connect';
}

function wireOf(contentType: string): Seen['wire'] {
  if (contentType.startsWith('application/grpc-web')) return 'grpc-web';
  if (contentType.startsWith('application/grpc')) return 'grpc';
  return 'connect';
}

const PREFIX = '/api/rpc';

/** One programmable upstream: h2c (gRPC + Connect) and HTTP/1.1 (gRPC-Web + Connect). */
function startUpstream() {
  const state = { gate: 'open' as Gate, seen: [] as Seen[] };
  const routes = (prefix?: string) =>
    connectNodeAdapter({
      ...(prefix ? { requestPathPrefix: prefix } : {}),
      routes(router) {
        router.service(EDGE, {
          wrap: (req: unknown) => req,
          get_item: (req: { note: string }) => create(envelope, { note: `got ${req.note}` }),
          fail: () => {
            throw new ConnectError('order 42 is locked', Code.FailedPrecondition);
          },
          async *many(req: { note: string }) {
            for (let i = 0; i < 3; i++) yield create(envelope, { note: `${req.note}#${i}` });
          },
        } as never);
      },
    });
  const plain = routes();
  const prefixed = routes(PREFIX);

  const handle = (req: Http2ServerRequest | import('node:http').IncomingMessage, res: never) => {
    const ct = String(req.headers['content-type'] ?? '');
    const wire = wireOf(ct);
    state.seen.push({ path: String(req.url), wire });
    const r = res as unknown as Http2ServerResponse;
    if (state.gate === 'http503') {
      r.writeHead(503, { 'content-type': 'text/plain' });
      r.end('upstream overloaded');
      return;
    }
    if (state.gate === 'connect-hangs') {
      if (wire === 'grpc') {
        r.writeHead(403, { 'content-type': 'text/html' });
        r.end('<html>forbidden</html>');
      }
      // Connect: never answer (the client's deadline fires).
      return;
    }
    if (state.gate === 'refuse-all') {
      r.writeHead(404, { 'content-type': 'text/plain' });
      r.end('no such route');
      return;
    }
    if (state.gate === 'native-only' && wire !== 'grpc') {
      r.writeHead(415, { 'content-type': 'text/plain' });
      r.end('grpc only');
      return;
    }
    if (state.gate === 'connect-only' && wire !== 'connect') {
      // e.g. an edge that refuses the gRPC content types
      r.writeHead(403, { 'content-type': 'text/html' });
      r.end('<html>forbidden</html>');
      return;
    }
    const target = String(req.url).startsWith(`${PREFIX}/`) ? prefixed : plain;
    target(req as never, res);
  };

  const sessions = new Set<ServerHttp2Session>();
  const h2: Http2Server = createH2cServer(handle as never);
  h2.on('session', (s) => {
    sessions.add(s);
    s.once('close', () => sessions.delete(s));
  });
  const h1: Server = createHttp1Server(handle as never);
  return {
    state,
    async listen() {
      await Promise.all([
        new Promise<void>((r) => h2.listen(0, '127.0.0.1', () => r())),
        new Promise<void>((r) => h1.listen(0, '127.0.0.1', () => r())),
      ]);
      return {
        h2Port: (h2.address() as AddressInfo).port,
        h1Port: (h1.address() as AddressInfo).port,
      };
    },
    async close() {
      for (const s of sessions) s.destroy();
      h1.closeAllConnections();
      await Promise.all([
        new Promise<void>((r) => h2.close(() => r())),
        new Promise<void>((r) => h1.close(() => r())),
      ]);
    },
  };
}

const upstream = startUpstream();
let h2Port = 0;
let h1Port = 0;

beforeAll(async () => {
  ({ h2Port, h1Port } = await upstream.listen());
});
afterAll(() => upstream.close());
beforeEach(() => {
  resetProtocolFallbackStateForTests();
  upstream.state.gate = 'open';
  upstream.state.seen.length = 0;
});
afterEach(() => resetProtocolFallbackStateForTests());

function call(
  method: string,
  message: unknown,
  opts: { path?: string; port?: number; wireProtocol?: 'grpc' | 'connect' | 'grpc-web' } = {}
) {
  const port = opts.port ?? h2Port;
  return executeConnectUnary({
    url: `http://localhost:${port}${opts.path ?? ''}`,
    dial: { ip: '127.0.0.1', port, family: 4 },
    service: 'live.v1.Edge',
    method,
    protoContent: PROTO,
    message,
    metadata: {},
    timeoutMs: 5000,
    ...(opts.wireProtocol ? { wireProtocol: opts.wireProtocol } : {}),
  });
}

const dialFor = (port = h2Port) => ({ ip: '127.0.0.1', port, family: 4 as const });

describe('native gRPC → Connect fallback (live)', () => {
  it('speaks native gRPC by default', async () => {
    const r = await call('Wrap', { note: 'a' });
    expect(r.status).toBe(0);
    expect(upstream.state.seen.map((s) => s.wire)).toEqual(['grpc']);
  });

  it('a transient 503 is reported as-is: no replay over Connect, no memo', async () => {
    upstream.state.gate = 'http503';
    const first = await call('Wrap', { note: 'a' });
    expect(first.status).toBe(Code.Unavailable);
    expect(first.error).toBe('HTTP 503');
    // Sent exactly once — never replayed over a second protocol.
    expect(upstream.state.seen.map((s) => s.wire)).toEqual(['grpc']);
    expect(isConnectPreferredForTests(`http://localhost:${h2Port}`, dialFor())).toBe(false);

    // The server recovers: the next call goes native and succeeds.
    upstream.state.gate = 'open';
    upstream.state.seen.length = 0;
    const second = await call('Wrap', { note: 'b' });
    expect(second.status).toBe(0);
    expect(upstream.state.seen.map((s) => s.wire)).toEqual(['grpc']);
  });

  it('falls back when native gRPC is refused, then memoises the origin', async () => {
    upstream.state.gate = 'connect-only';
    const first = await call('Wrap', { note: 'a' });
    expect(first.status).toBe(0);
    expect(upstream.state.seen.map((s) => s.wire)).toEqual(['grpc', 'connect']);
    expect(isConnectPreferredForTests(`http://localhost:${h2Port}`, dialFor())).toBe(true);

    upstream.state.seen.length = 0;
    const second = await call('Wrap', { note: 'b' });
    expect(second.status).toBe(0);
    expect(upstream.state.seen.map((s) => s.wire)).toEqual(['connect']);
  });

  it('heals a memoised origin that now speaks only native gRPC', async () => {
    upstream.state.gate = 'connect-only';
    await call('Wrap', { note: 'a' });
    expect(isConnectPreferredForTests(`http://localhost:${h2Port}`, dialFor())).toBe(true);

    upstream.state.gate = 'native-only';
    upstream.state.seen.length = 0;
    const r = await call('Wrap', { note: 'b' });
    expect(r.status).toBe(0);
    expect(upstream.state.seen.map((s) => s.wire)).toEqual(['connect', 'grpc']);
    expect(isConnectPreferredForTests(`http://localhost:${h2Port}`, dialFor())).toBe(false);

    upstream.state.seen.length = 0;
    await call('Wrap', { note: 'c' });
    expect(upstream.state.seen.map((s) => s.wire)).toEqual(['grpc']);
  });

  it('does not memoise when the Connect fallback is refused too', async () => {
    upstream.state.gate = 'refuse-all';
    const r = await call('Wrap', { note: 'a' });
    expect(r.status).toBe(Code.Unimplemented);
    expect(r.error).toBe(
      'Server rejected native gRPC (HTTP 404); Connect protocol fallback also failed: HTTP 404'
    );
    expect(upstream.state.seen.map((s) => s.wire)).toEqual(['grpc', 'connect']);
    expect(isConnectPreferredForTests(`http://localhost:${h2Port}`, dialFor())).toBe(false);
  });

  it('does not memoise Connect when the fallback attempt times out', async () => {
    upstream.state.gate = 'connect-hangs';
    const r = await executeConnectUnary({
      url: `http://localhost:${h2Port}`,
      dial: dialFor(),
      service: 'live.v1.Edge',
      method: 'Wrap',
      protoContent: PROTO,
      message: { note: 't' },
      metadata: {},
      timeoutMs: 300,
    });
    expect(r.status).toBe(Code.DeadlineExceeded);
    expect(upstream.state.seen.map((s) => s.wire)).toEqual(['grpc', 'connect']);
    expect(isConnectPreferredForTests(`http://localhost:${h2Port}`, dialFor())).toBe(false);
  });

  it('keeps the server message for a genuine gRPC error and never falls back', async () => {
    const r = await call('Fail', { note: 'a' });
    expect(r.status).toBe(Code.FailedPrecondition);
    expect(r.error).toBe('order 42 is locked');
    expect(upstream.state.seen.map((s) => s.wire)).toEqual(['grpc']);
  });
});

describe('URL path prefix (live)', () => {
  it.each([
    ['auto', undefined, () => h2Port],
    ['native gRPC', 'grpc' as const, () => h2Port],
    ['Connect', 'connect' as const, () => h2Port],
    ['gRPC-Web', 'grpc-web' as const, () => h1Port],
  ])('%s keeps the path prefix of the URL', async (_label, wireProtocol, port) => {
    const r = await call(
      'Wrap',
      { note: 'p' },
      { path: `${PREFIX}/`, port: port(), ...(wireProtocol ? { wireProtocol } : {}) }
    );
    expect(r.status, r.error).toBe(0);
    expect(upstream.state.seen[0]?.path).toBe(`${PREFIX}/live.v1.Edge/Wrap`);
  });
});

describe('protobuf JSON edge cases (live)', () => {
  it('round-trips google.protobuf.Any over native gRPC', async () => {
    const r = await call('Wrap', { note: 'any', payload: INNER_ANY });
    expect(r.status, r.error).toBe(0);
    expect(r.message).toEqual({ note: 'any', payload: INNER_ANY });
  });

  it('round-trips google.protobuf.Any over gRPC-Web', async () => {
    const r = await call(
      'Wrap',
      { note: 'any', payload: INNER_ANY },
      { port: h1Port, wireProtocol: 'grpc-web' }
    );
    expect(r.status, r.error).toBe(0);
    expect(r.message).toEqual({ note: 'any', payload: INNER_ANY });
  });

  it('calls a method whose name is not PascalCase', async () => {
    const r = await call('get_item', { note: 'x' });
    expect(r.status, r.error).toBe(0);
    expect(r.message).toMatchObject({ note: 'got x' });
  });

  it('collects a server stream over the live wire', async () => {
    const r = await executeConnectServerStreamCollect({
      url: `http://localhost:${h2Port}`,
      dial: dialFor(),
      service: 'live.v1.Edge',
      method: 'Many',
      protoContent: PROTO,
      message: { note: 's' },
      metadata: {},
      timeoutMs: 5000,
    });
    expect(r.status).toBe(0);
    expect(r.messages.map((m) => (m as { note: string }).note)).toEqual(['s#0', 's#1', 's#2']);
  });
});
