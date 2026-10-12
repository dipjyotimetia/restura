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
