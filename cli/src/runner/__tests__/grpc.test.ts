import type { GrpcMethodType, GrpcRequest } from '@shared/types';
import { describe, expect, it, vi } from 'vitest';

const proxySpy = vi.hoisted(() => vi.fn());
vi.mock('@shared/protocol/grpc-proxy', () => ({
  executeGrpcProxy: (spec: unknown) => {
    proxySpy(spec);
    return Promise.resolve({ ok: false, status: 502, payload: { error: 'stubbed' } });
  },
}));

import type { LoadedRequest } from '../collectionLoader';
import { executeGrpc } from '../executors/grpc';
import type { ExecuteOptions } from '../executors/types';

const opts: ExecuteOptions = { vars: {}, timeoutMs: 5000, allowLocalhost: true };

function grpcRequest(methodType: GrpcMethodType, extra: Partial<GrpcRequest> = {}): LoadedRequest {
  const request: GrpcRequest = {
    id: 'g1',
    name: 'Call',
    type: 'grpc',
    methodType,
    url: 'http://127.0.0.1:1/',
    service: 'echo.EchoService',
    method: 'Echo',
    metadata: [],
    message: '{}',
    auth: { type: 'none' },
    ...extra,
  };
  return { relativePath: 'a.grpc', folderPath: [], type: 'grpc', request };
}

describe('gRPC executor — streaming guard', () => {
  it.each<GrpcMethodType>(['server-streaming', 'client-streaming', 'bidirectional-streaming'])(
    'fails explicitly for %s methods instead of downgrading to unary',
    async (methodType) => {
      const outcome = await executeGrpc(grpcRequest(methodType), opts);
      expect(outcome.passed).toBe(false);
      expect(outcome.errorMessage).toContain(methodType);
      expect(outcome.errorMessage).toMatch(/does not support/i);
    }
  );
});

describe('gRPC executor — per-request timeout (#921)', () => {
  it('a saved request timeout overrides the global --timeout', async () => {
    proxySpy.mockClear();
    await executeGrpc(grpcRequest('unary', { timeout: 1234 }), opts);
    expect(proxySpy.mock.calls[0]?.[0]).toMatchObject({ timeout: 1234 });
  });

  it('falls back to the global --timeout when the request has none', async () => {
    proxySpy.mockClear();
    await executeGrpc(grpcRequest('unary'), opts);
    expect(proxySpy.mock.calls[0]?.[0]).toMatchObject({ timeout: 5000 });
  });
});

describe('gRPC executor — 64-bit integer precision', () => {
  it('sends an int64 entered as a JSON number beyond 2^53 without rounding', async () => {
    proxySpy.mockClear();
    await executeGrpc(grpcRequest('unary', { message: '{"big": 9007199254740993}' }), opts);
    expect(proxySpy.mock.calls[0]?.[0]).toMatchObject({ message: { big: '9007199254740993' } });
  });
});

describe('gRPC executor — Struct numbers stay numbers (app parity)', () => {
  const proto = `syntax = "proto3";
package echo;
import "google/protobuf/struct.proto";
message EchoRequest { int64 big = 1; google.protobuf.Struct st = 2; }
message EchoResponse {}
service EchoService { rpc Echo (EchoRequest) returns (EchoResponse); }`;

  it('quotes an unsafe int64 field but keeps a Struct value a JSON number', async () => {
    proxySpy.mockClear();
    await executeGrpc(
      grpcRequest('unary', {
        message: '{"big": 9007199254740993, "st": {"n": 12345678901234567890}}',
        schema: { kind: 'proto', text: proto, fileName: 'echo.proto' },
      }),
      opts
    );
    const sent = (proxySpy.mock.calls[0]?.[0] as { message: { big: unknown; st: { n: unknown } } })
      .message;
    expect(sent.big).toBe('9007199254740993');
    expect(typeof sent.st.n).toBe('number');
  });
});
