/**
 * #925 / #944 — unknown request JSON keys are handled before anything is sent,
 * on both transports (the web path relays JSON and never encodes it
 * client-side): refused in `block` mode, stripped in `warn` (default) / `off`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GrpcRequest, GrpcResponse } from '@/types';

const platform = vi.hoisted(() => ({ electron: false }));
const wire = vi.hoisted(() => ({ electron: vi.fn(), proxy: vi.fn() }));

vi.mock('@/lib/shared/platform', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/shared/platform')>()),
  isElectron: () => platform.electron,
}));

vi.mock('@/features/grpc/lib/grpcClient', async (importActual) => ({
  ...(await importActual<typeof import('@/features/grpc/lib/grpcClient')>()),
  makeElectronGrpcRequest: (...args: unknown[]) => wire.electron(...args),
  makeProxyGrpcRequest: (...args: unknown[]) => wire.proxy(...args),
}));

import { useSettingsStore } from '@/store/useSettingsStore';
import { grpcProtocol } from '../protocol';

const PROTO = `syntax = "proto3";
package greet.v1;
message HelloRequest { string name = 1; }
message HelloReply { string message = 1; }
service Greeter { rpc SayHello(HelloRequest) returns (HelloReply); }`;

const ok: GrpcResponse = {
  id: 'r',
  requestId: 'g1',
  status: 0,
  statusText: 'OK',
  headers: {},
  body: '{}',
  size: 2,
  time: 1,
  timestamp: 1,
  grpcStatus: 0,
};

function request(message: string): GrpcRequest {
  return {
    id: 'g1',
    name: 'SayHello',
    type: 'grpc',
    methodType: 'unary',
    url: 'http://localhost:50051',
    service: 'greet.v1.Greeter',
    method: 'SayHello',
    metadata: [],
    message,
    auth: { type: 'none' },
    schema: { kind: 'proto', fileName: 'greet.proto', text: PROTO },
  };
}

const run = (req: GrpcRequest) =>
  grpcProtocol.runRequest(req, {
    signal: new AbortController().signal,
    variables: { who: 'world' },
    protocolOptions: { protoContent: PROTO, protoFileName: 'greet.proto' },
  }) as Promise<GrpcResponse>;

beforeEach(() => {
  wire.electron.mockReset().mockResolvedValue(ok);
  wire.proxy.mockReset().mockResolvedValue(ok);
});

describe.each([
  ['web', false],
  ['desktop', true],
])('grpcProtocol unknown request fields (%s)', (_label, electron) => {
  const setMode = (grpcUnknownFields: 'warn' | 'block' | 'off' | undefined) =>
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, grpcUnknownFields } }));
  const sentMessage = () =>
    ((electron ? wire.electron : wire.proxy).mock.calls[0]?.[0] as GrpcRequest).message;

  beforeEach(() => {
    platform.electron = electron;
    setMode('block');
  });

  it('block: refuses a typo with INVALID_ARGUMENT listing the key, sending nothing', async () => {
    const res = await run(request('{"nmae": "{{who}}"}'));
    expect(wire.electron).not.toHaveBeenCalled();
    expect(wire.proxy).not.toHaveBeenCalled();
    expect(res.grpcStatus).toBe(3);
    expect(res.body).toContain('nmae (did you mean \\"name\\"?)');
  });

  it('sends a message whose keys are all known', async () => {
    await run(request('{"name": "{{who}}"}'));
    expect(electron ? wire.electron : wire.proxy).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 'warn', 'off'] as const)(
    '%s (default warn): sends the message without the unknown key',
    async (mode) => {
      setMode(mode);
      const res = await run(request('{"nmae": "x", "name": "{{who}}"}'));
      expect(res.grpcStatus).toBe(0);
      expect(JSON.parse(sentMessage())).toEqual({ name: '{{who}}' });
    }
  );
});
