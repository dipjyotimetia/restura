import { describe, expect, it } from 'vitest';
import type { GrpcMethodType, GrpcRequest } from '@/types';
import type { LoadedRequest } from '../collectionLoader';
import { executeGrpc } from '../executors/grpc';
import type { ExecuteOptions } from '../executors/types';

const opts: ExecuteOptions = { vars: {}, timeoutMs: 5000, allowLocalhost: true };

function grpcRequest(methodType: GrpcMethodType): LoadedRequest {
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
  };
  return { relativePath: 'a.grpc', folderPath: [], type: 'grpc', request };
}

describe('gRPC executor — streaming guard', () => {
  it.each<GrpcMethodType>([
    'server-streaming',
    'client-streaming',
    'bidirectional-streaming',
  ])('fails explicitly for %s methods instead of downgrading to unary', async (methodType) => {
    const outcome = await executeGrpc(grpcRequest(methodType), opts);
    expect(outcome.passed).toBe(false);
    expect(outcome.errorMessage).toContain(methodType);
    expect(outcome.errorMessage).toMatch(/does not support/i);
  });
});
