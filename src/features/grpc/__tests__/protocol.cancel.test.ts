/**
 * Unary gRPC honours the run's abort signal (Cancel in the response panel,
 * collection-run abort): the Worker / gRPC-Web fetch receives the signal, and
 * every harness — Electron IPC included, which has no unary cancel channel —
 * rejects promptly with AbortError instead of waiting for the reply.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GrpcRequest } from '@/types';

const electron = vi.hoisted(() => ({ on: false }));
const proxyCall = vi.fn();
const electronCall = vi.fn();
const grpcWebCall = vi.fn();

vi.mock('@/lib/shared/platform', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/shared/platform')>()),
  isElectron: () => electron.on,
}));

vi.mock('@/features/grpc/lib/grpcClient', async (importActual) => ({
  ...(await importActual<typeof import('@/features/grpc/lib/grpcClient')>()),
  makeProxyGrpcRequest: (...args: unknown[]) => proxyCall(...args),
  makeElectronGrpcRequest: (...args: unknown[]) => electronCall(...args),
}));

vi.mock('@/features/grpc/lib/grpcWebClient', async (importActual) => ({
  ...(await importActual<typeof import('@/features/grpc/lib/grpcWebClient')>()),
  makeGrpcWebRequest: (...args: unknown[]) => grpcWebCall(...args),
}));

import { grpcProtocol } from '../protocol';

function grpcReq(extra: Partial<GrpcRequest> = {}): GrpcRequest {
  return {
    id: 'g1',
    name: 'SayHello',
    type: 'grpc',
    methodType: 'unary',
    url: 'https://h.example.com',
    service: 'greet.v1.GreetService',
    method: 'SayHello',
    metadata: [],
    message: '{"name":"world"}',
    auth: { type: 'none' },
    ...extra,
  };
}

const never = () => new Promise<never>(() => {});

beforeEach(() => {
  proxyCall.mockReset().mockImplementation(never);
  electronCall.mockReset().mockImplementation(never);
  grpcWebCall.mockReset().mockImplementation(never);
  electron.on = false;
});

describe('unary gRPC cancellation', () => {
  it.each([
    ['web Connect relay', false, undefined, proxyCall],
    ['web gRPC-Web relay', false, 'grpc-web' as const, grpcWebCall],
    ['desktop IPC', true, undefined, electronCall],
  ])('%s: aborting rejects promptly with AbortError', async (_name, desktop, wire, call) => {
    electron.on = desktop;
    const ctrl = new AbortController();
    const run = grpcProtocol.runRequest(grpcReq(wire ? { wireProtocol: wire } : {}), {
      signal: ctrl.signal,
      variables: {},
      protocolOptions: { descriptors: ['AAA='] },
    });
    await vi.waitFor(() => expect(call).toHaveBeenCalled());
    ctrl.abort();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('hands the signal to the Worker relay fetch', async () => {
    const ctrl = new AbortController();
    void grpcProtocol
      .runRequest(grpcReq(), { signal: ctrl.signal, variables: {} })
      .catch(() => {});
    await vi.waitFor(() => expect(proxyCall).toHaveBeenCalled());
    expect(proxyCall.mock.calls[0]).toContain(ctrl.signal);
    ctrl.abort();
  });

  it('hands the signal to the gRPC-Web relay fetch', async () => {
    const ctrl = new AbortController();
    void grpcProtocol
      .runRequest(grpcReq({ wireProtocol: 'grpc-web' }), { signal: ctrl.signal, variables: {} })
      .catch(() => {});
    await vi.waitFor(() => expect(grpcWebCall).toHaveBeenCalled());
    expect(grpcWebCall.mock.calls[0]).toContain(ctrl.signal);
    ctrl.abort();
  });
});
