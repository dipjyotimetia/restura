// @vitest-environment node
//
// SEC-G1 (#929): a hostile gRPC server must not be able to make the Electron
// main process allocate unbounded memory. These run the REAL connect-node
// transports (buildConnectTransport / buildConnectFallbackTransport, no injected
// transport) against a local HTTP/2 server so the transport-level caps
// (readMaxBytes, post-decompression bound) are exercised end to end.
import { readFileSync } from 'node:fs';
import * as http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { Code, ConnectError } from '@connectrpc/connect';
import { compressionGzip, connectNodeAdapter } from '@connectrpc/connect-node';
import { registryFromProtoText } from '@shared/protocol/grpc-registry';
import { MAX_RESPONSE_SIZE } from '@shared/protocol/http-proxy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../security/secret-handle-store', () => ({
  unwrapSecretValueMain: (v: unknown) => (typeof v === 'string' ? v : undefined),
}));

import {
  type ConnectStreamHandlers,
  executeConnectServerStreamCollect,
  executeConnectUnary,
  resetProtocolFallbackStateForTests,
  runConnectStream,
} from '../handlers/grpc-connect';

const ECHO_PROTO = readFileSync(resolve(__dirname, '../../../e2e/mocks/proto/echo.proto'), 'utf8');
const SERVICE = 'echo.v1.EchoService';
// One byte over the cap: a single message the client must refuse.
const OVERSIZED = 'a'.repeat(MAX_RESPONSE_SIZE + 1024);

interface ServerOpts {
  /** Server-side response compression. `[]` → identity on the wire. */
  acceptCompression: (typeof compressionGzip)[];
  /** Payload the server returns for every call. */
  payload: string;
}

let server: http2.Http2Server | null = null;
// Open HTTP/2 sessions — connect-node keeps client sessions alive while idle,
// and `server.close()` only calls back once every session has closed.
const sessions = new Set<http2.ServerHttp2Session>();

async function startServer(opts: ServerOpts): Promise<number> {
  const service = registryFromProtoText(ECHO_PROTO).getService(SERVICE)!;
  const handler = connectNodeAdapter({
    acceptCompression: opts.acceptCompression,
    // Compress anything (default threshold is 1 KiB, payloads are larger anyway).
    compressMinBytes: 1,
    routes: (router) => {
      router.service(service, {
        unaryEcho: () => ({ message: opts.payload, index: 0 }),
        async *serverStreamingEcho() {
          yield { message: 'small', index: 0 };
          yield { message: opts.payload, index: 1 };
        },
        clientStreamingEcho: () => {
          throw new ConnectError('unimplemented', Code.Unimplemented);
        },
        async *bidirectionalEcho() {
          throw new ConnectError('unimplemented', Code.Unimplemented);
        },
      } as never);
    },
  });
  server = http2.createServer(handler);
  server.on('session', (session) => {
    sessions.add(session);
    session.once('close', () => sessions.delete(session));
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  return (server!.address() as AddressInfo).port;
}

function argsFor(port: number, method: string) {
  return {
    url: `grpc://127.0.0.1:${port}`,
    dial: { ip: '127.0.0.1', port, family: 4 as const },
    service: SERVICE,
    method,
    protoContent: ECHO_PROTO,
    message: { message: 'hi' },
    metadata: {} as Record<string, string>,
    timeoutMs: 20_000,
  };
}

beforeEach(resetProtocolFallbackStateForTests);

afterEach(async () => {
  const s = server;
  server = null;
  if (!s) return;
  const closed = new Promise<void>((done) => s.close(() => done()));
  for (const session of sessions) session.destroy();
  sessions.clear();
  await closed;
});

describe('gRPC response caps (SEC-G1)', () => {
  it('rejects an oversized unary response with RESOURCE_EXHAUSTED', async () => {
    const port = await startServer({ acceptCompression: [], payload: OVERSIZED });
    const r = await executeConnectUnary(argsFor(port, 'UnaryEcho'));
    expect(r.status).toBe(Code.ResourceExhausted);
    expect(r.statusText).toBe('RESOURCE_EXHAUSTED');
    expect(r.message).toBeUndefined();
    expect(r.error).toMatch(/readMaxBytes/);
  });

  it('rejects a gzip decompression bomb (small on the wire, huge decoded)', async () => {
    const port = await startServer({
      acceptCompression: [compressionGzip],
      payload: OVERSIZED,
    });
    const r = await executeConnectUnary(argsFor(port, 'UnaryEcho'));
    expect(r.status).toBe(Code.ResourceExhausted);
    expect(r.message).toBeUndefined();
    // Proves the compressed path tripped the post-decompression bound.
    expect(r.error).toMatch(/after decompression/);
  });

  it('still accepts an in-limit unary response', async () => {
    const port = await startServer({ acceptCompression: [compressionGzip], payload: 'ok' });
    const r = await executeConnectUnary(argsFor(port, 'UnaryEcho'));
    expect(r.status).toBe(0);
    expect(r.message).toEqual({ message: 'ok', index: 0 });
  });

  it('caps each streamed message before decode and ends with RESOURCE_EXHAUSTED', async () => {
    const port = await startServer({ acceptCompression: [], payload: OVERSIZED });
    const messages: unknown[] = [];
    const closed = await new Promise<{ code: number; details: string }>((done) => {
      const handlers: ConnectStreamHandlers = {
        onMessage: (m) => messages.push(m),
        onHeaders: () => {},
        onTrailers: () => {},
        onClose: (code, details) => done({ code, details }),
        onCancelled: () => done({ code: -1, details: 'cancelled' }),
      };
      runConnectStream(argsFor(port, 'ServerStreamingEcho'), handlers);
    });
    expect(closed.code).toBe(Code.ResourceExhausted);
    expect(closed.details).toMatch(/readMaxBytes/);
    // The in-limit message before the oversized one was delivered.
    expect(messages).toEqual([{ message: 'small', index: 0 }]);
  });

  it('caps a buffered server-stream collect per message', async () => {
    const port = await startServer({ acceptCompression: [compressionGzip], payload: OVERSIZED });
    const r = await executeConnectServerStreamCollect(argsFor(port, 'ServerStreamingEcho'));
    expect(r.status).toBe(Code.ResourceExhausted);
    expect(r.messages).toEqual([{ message: 'small', index: 0 }]);
  });
});
