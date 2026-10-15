/**
 * Regression net for #871 (GRPC-1): the desktop collection runner used to fail
 * every gRPC item because it passed no schema to `grpcProtocol.runRequest`,
 * whose Electron branch requires reflection descriptors or proto text.
 *
 * Drives the REAL runner → REAL gRPC protocol module; only the wire
 * (`makeElectronGrpcRequest`) and reflection client are faked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Collection, GrpcRequest, GrpcResponse } from '@/types';
import type { RunnableRequest } from '../flattenRunnables';

const electronCall = vi.fn();
const discoverServices = vi.fn();
const startStream = vi.fn();
const platform = vi.hoisted(() => ({ electron: true }));

vi.mock('@/lib/shared/platform', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/shared/platform')>()),
  isElectron: () => platform.electron,
}));

vi.mock('@/features/grpc/lib/grpcStreamingClient', () => ({
  startGrpcStream: (...args: unknown[]) => startStream(...args),
}));

vi.mock('@/features/grpc/lib/grpcClient', async (importActual) => ({
  ...(await importActual<typeof import('@/features/grpc/lib/grpcClient')>()),
  makeElectronGrpcRequest: (...args: unknown[]) => electronCall(...args),
}));

vi.mock('@/features/grpc/lib/grpcReflection', async (importActual) => ({
  ...(await importActual<typeof import('@/features/grpc/lib/grpcReflection')>()),
  GrpcReflectionClient: class {
    constructor(public url: string) {}
    discoverServices() {
      return discoverServices(this.url);
    }
  },
}));

vi.mock('@/features/registry/registry', async () => {
  const { grpcProtocol } = await import('@/features/grpc/protocol');
  return { protocolRegistry: { get: (id: string) => (id === 'grpc' ? grpcProtocol : undefined) } };
});

import { clearReflectionFallbackCache } from '@/features/grpc/lib/grpcSchemaSnapshot';
import { useCollectionStore } from '@/store/useCollectionStore';
import { runCollection } from '../collectionRunner';

const okResponse = (): GrpcResponse => ({
  id: 'r',
  requestId: 'req',
  status: 200,
  statusText: 'OK',
  headers: {},
  body: '{"message":"hi"}',
  size: 16,
  time: 1,
  timestamp: Date.now(),
  grpcStatus: 0,
  grpcStatusText: 'OK',
});

function grpcReq(extra: Partial<GrpcRequest> = {}): GrpcRequest {
  return {
    id: 'g1',
    name: 'SayHello',
    type: 'grpc',
    methodType: 'unary',
    url: 'http://{{host}}',
    service: 'greet.v1.GreetService',
    method: 'SayHello',
    metadata: [],
    message: '{"name":"world"}',
    auth: { type: 'none' },
    ...extra,
  };
}

const collection: Collection = { id: 'c', name: 'C', items: [] };

async function run(request: GrpcRequest) {
  const runnable: RunnableRequest = { itemId: 'i1', name: request.name, request };
  return runCollection(
    {
      collection,
      scopeName: 'C',
      runnables: [runnable],
      baseVars: { host: '127.0.0.1:50051' },
      iterations: 1,
      dataRows: [],
      delayMs: 0,
      stopOnFailure: false,
    },
    () => {},
    new AbortController().signal
  );
}

beforeEach(() => {
  platform.electron = true;
  startStream.mockReset();
  electronCall.mockReset().mockResolvedValue(okResponse());
  discoverServices.mockReset();
  clearReflectionFallbackCache();
  useCollectionStore.setState({ collections: [collection], activeCollectionId: null });
});

describe('collection runner — desktop gRPC schema snapshot (#871)', () => {
  it('runs a reflection-snapshot request: descriptors + timeout reach the Electron call', async () => {
    const result = await run(
      grpcReq({ schema: { kind: 'descriptors', descriptors: ['AAA=', 'BBB='] }, timeout: 4321 })
    );
    expect(result.requests[0]?.status).toBe('success');
    expect(electronCall).toHaveBeenCalledTimes(1);
    const [, , , , timeoutMs, , descriptors] = electronCall.mock.calls[0]!;
    expect(descriptors).toEqual(['AAA=', 'BBB=']);
    expect(timeoutMs).toBe(4321);
    expect(discoverServices).not.toHaveBeenCalled();
  });

  it('runs an uploaded-proto snapshot request: proto text + file name reach the Electron call', async () => {
    const text = 'syntax = "proto3";\npackage greet.v1;';
    const result = await run(grpcReq({ schema: { kind: 'proto', fileName: 'greet.proto', text } }));
    expect(result.requests[0]?.status).toBe('success');
    const [, protoContent, protoFileName, , timeoutMs, , descriptors] = electronCall.mock.calls[0]!;
    expect(protoContent).toBe(text);
    expect(protoFileName).toBe('greet.proto');
    expect(timeoutMs).toBe(30000);
    expect(descriptors).toBeUndefined();
    expect(discoverServices).not.toHaveBeenCalled();
  });

  it('with no snapshot, falls back to server reflection against the resolved URL', async () => {
    discoverServices.mockResolvedValue({
      success: true,
      serverUrl: 'http://127.0.0.1:50051',
      timestamp: 0,
      services: [
        {
          name: 'GreetService',
          fullName: 'greet.v1.GreetService',
          methods: [],
          descriptors: ['REFL='],
        },
      ],
    });
    const result = await run(grpcReq());
    expect(result.requests[0]?.status).toBe('success');
    expect(discoverServices).toHaveBeenCalledWith('http://127.0.0.1:50051');
    expect(electronCall.mock.calls[0]![6]).toEqual(['REFL=']);
  });

  it('with no snapshot and reflection unavailable, fails with an actionable error', async () => {
    discoverServices.mockResolvedValue({
      success: false,
      services: [],
      error: 'UNIMPLEMENTED: reflection disabled',
      serverUrl: 'http://127.0.0.1:50051',
      timestamp: 0,
    });
    const result = await run(grpcReq());
    const r = result.requests[0];
    expect(r?.status).toBe('failed');
    expect(r?.error).toMatch(/reflection disabled/);
    expect(r?.error).toMatch(/click Discover \(reflection\) or upload a \.proto/);
    expect(electronCall).not.toHaveBeenCalled();
  });

  it('fails actionably when reflection does not expose the saved service', async () => {
    discoverServices.mockResolvedValue({
      success: true,
      serverUrl: 'http://127.0.0.1:50051',
      timestamp: 0,
      services: [{ name: 'Other', fullName: 'other.v1.Other', methods: [], descriptors: ['X='] }],
    });
    const result = await run(grpcReq());
    expect(result.requests[0]?.error).toMatch(/does not expose that service/);
  });
});

/** A finished stream handle yielding `inbound` then settling OK. */
function streamHandle(inbound: unknown[]) {
  const sent: unknown[] = [];
  return {
    sent,
    handle: {
      messages: (async function* () {
        yield* inbound;
      })(),
      send: async (m: unknown) => {
        sent.push(m);
      },
      closeSend: () => {},
      cancel: () => {},
      done: Promise.resolve({ headers: {}, trailers: { 'x-t': '1' }, status: 0 }),
    },
  };
}

describe('collection runner — gRPC streams (#917)', () => {
  it.each([true, false])(
    'runs a server-streaming request and its test script (desktop=%s)',
    async (desktop) => {
      platform.electron = desktop;
      const s = streamHandle([{ n: 1 }, { n: 2 }]);
      startStream.mockResolvedValue(s.handle);
      const result = await run(
        grpcReq({
          methodType: 'server-streaming',
          schema: { kind: 'descriptors', descriptors: ['AAA='] },
          testScript: `rs.test('two', () => rs.expect(rs.response.messages.count()).to.equal(2));
rs.test('trailer', () => rs.expect(rs.response.trailers.get('x-t')).to.equal('1'));`,
        })
      );
      const r = result.requests[0];
      expect(r?.status).toBe('success');
      expect(r?.assertions.map((a) => a.passed)).toEqual([true, true]);
      expect(startStream).toHaveBeenCalledTimes(1);
      expect(electronCall).not.toHaveBeenCalled();
    }
  );

  it('runs a client stream on desktop, sending the request messages', async () => {
    const s = streamHandle([{ total: 2 }]);
    startStream.mockResolvedValue(s.handle);
    const result = await run(
      grpcReq({
        methodType: 'client-streaming',
        message: '[{"v":1},{"v":2}]',
        schema: { kind: 'descriptors', descriptors: ['AAA='] },
      })
    );
    expect(result.requests[0]?.status).toBe('success');
    expect(s.sent).toEqual([{ v: 1 }, { v: 2 }]);
  });

  it.each(['client-streaming', 'bidirectional-streaming'] as const)(
    'skips %s on the web with a desktop-only reason',
    async (methodType) => {
      platform.electron = false;
      const result = await run(grpcReq({ methodType }));
      expect(result.requests[0]?.status).toBe('skipped');
      expect(result.requests[0]?.skippedReason).toMatch(/desktop app only/);
      expect(startStream).not.toHaveBeenCalled();
    }
  );
});
