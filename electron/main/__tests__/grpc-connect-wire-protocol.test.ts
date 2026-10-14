// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type MockGrpcServerHandle, startMockGrpcServer } from '../../../e2e/mocks/grpcServer';

vi.mock('../security/secret-handle-store', () => ({
  unwrapSecretValueMain: (v: unknown) => (typeof v === 'string' ? v : undefined),
}));

import {
  executeConnectServerStreamCollect,
  executeConnectUnary,
  resetProtocolFallbackStateForTests,
} from '../handlers/grpc-connect';

/**
 * Per-request wire protocol pinning on desktop (#914), against a real server
 * (the e2e mock's connect-node adapter on HTTP/1.1, which speaks gRPC-Web and
 * Connect but not native gRPC — native gRPC needs HTTP/2).
 */

const ECHO_PROTO = readFileSync(resolve(__dirname, '../../../e2e/mocks/proto/echo.proto'), 'utf8');

let server: MockGrpcServerHandle;

beforeAll(async () => {
  server = await startMockGrpcServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(resetProtocolFallbackStateForTests);

function args() {
  return {
    url: server.url,
    dial: { ip: '127.0.0.1', port: server.port, family: 4 as const },
    service: 'echo.v1.EchoService',
    method: 'UnaryEcho',
    protoContent: ECHO_PROTO,
    message: { message: 'hi' },
    metadata: {} as Record<string, string>,
    timeoutMs: 5000,
  };
}

describe('desktop gRPC wire protocol', () => {
  it('grpc-web: unary call succeeds over gRPC-Web', async () => {
    const r = await executeConnectUnary({ ...args(), wireProtocol: 'grpc-web' });
    expect(r.status).toBe(0);
    expect(r.message).toEqual({ message: 'echo: hi', index: 0 });
  });

  it('grpc-web: server-streaming collects every message', async () => {
    const r = await executeConnectServerStreamCollect({
      ...args(),
      method: 'ServerStreamingEcho',
      message: { message: 's', count: 3 },
      wireProtocol: 'grpc-web',
    });
    expect(r.status).toBe(0);
    expect(r.messages).toHaveLength(3);
  });

  it('connect: pins the Connect protocol (h2c port)', async () => {
    const h2cPort = Number(new URL(server.h2cUrl).port);
    const r = await executeConnectUnary({
      ...args(),
      url: server.h2cUrl,
      dial: { ip: '127.0.0.1', port: h2cPort, family: 4 as const },
      wireProtocol: 'connect',
    });
    expect(r.status).toBe(0);
  });

  it('grpc: pins native gRPC with no Connect fallback', async () => {
    const r = await executeConnectUnary({ ...args(), wireProtocol: 'grpc' });
    expect(r.status).not.toBe(0);
  });
});
