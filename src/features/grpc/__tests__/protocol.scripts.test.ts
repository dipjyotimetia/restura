/**
 * #910 — the gRPC protocol module threads response metadata + trailers into
 * test scripts and applies pre-request `rs.request.metadata` edits to the
 * outgoing call. Drives the REAL protocol module + REAL QuickJS sandbox; only
 * the wire (`makeProxyGrpcRequest` / `makeElectronGrpcRequest`) is faked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GrpcRequest, GrpcResponse } from '@/types';

const electron = vi.hoisted(() => ({ on: false }));
const proxyCall = vi.fn();
const electronCall = vi.fn();

vi.mock('@/lib/shared/platform', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/shared/platform')>()),
  isElectron: () => electron.on,
}));

vi.mock('@/features/grpc/lib/grpcClient', async (importActual) => ({
  ...(await importActual<typeof import('@/features/grpc/lib/grpcClient')>()),
  makeProxyGrpcRequest: (...args: unknown[]) => proxyCall(...args),
  makeElectronGrpcRequest: (...args: unknown[]) => electronCall(...args),
}));

import type { ProtocolScriptResult } from '@/features/registry/types';
import { grpcProtocol } from '../protocol';

const response = (): GrpcResponse => ({
  id: 'r',
  requestId: 'g1',
  status: 0,
  statusText: 'OK',
  headers: { 'x-foo': 'bar' },
  trailers: { 'grpc-status': '0', 'x-trailer': 't1' },
  body: '{"message":"hi"}',
  size: 16,
  time: 1,
  timestamp: 0,
  grpcStatus: 0,
  grpcStatusText: 'OK',
});

function grpcReq(extra: Partial<GrpcRequest> = {}): GrpcRequest {
  return {
    id: 'g1',
    name: 'SayHello',
    type: 'grpc',
    methodType: 'unary',
    url: 'http://h',
    service: 'greet.v1.GreetService',
    method: 'SayHello',
    metadata: [{ id: 'm1', key: 'X-Tenant', value: '{{tenant}}', enabled: true }],
    message: '{"name":"world"}',
    auth: { type: 'none' },
    ...extra,
  };
}

async function run(request: GrpcRequest) {
  let scripts: ProtocolScriptResult | undefined;
  const res = await grpcProtocol.runRequest(request, {
    signal: new AbortController().signal,
    variables: { tenant: 'acme' },
    onScriptResult: (r) => {
      scripts = r;
    },
    protocolOptions: { descriptors: ['AAA='] },
  });
  return { res, scripts };
}

beforeEach(() => {
  proxyCall.mockReset().mockResolvedValue(response());
  electronCall.mockReset().mockResolvedValue(response());
  electron.on = false;
});

describe.each([
  ['web', false],
  ['desktop', true],
])('gRPC unary scripts on %s (#910)', (_name, isDesktop) => {
  const call = () => (isDesktop ? electronCall : proxyCall);
  beforeEach(() => {
    electron.on = isDesktop;
  });

  it('test scripts see response metadata and trailers', async () => {
    const { scripts } = await run(
      grpcReq({
        testScript: `
          rs.test('header', () => rs.expect(rs.response.headers.get('x-foo')).to.equal('bar'));
          rs.test('trailer', () => rs.expect(rs.response.trailers.get('x-trailer')).to.equal('t1'));
          rs.test('grpc-status', () => rs.expect(response.trailers['grpc-status']).to.equal('0'));
          rs.test('request md', () => rs.expect(rs.request.metadata['x-tenant']).to.equal('acme'));
        `,
      })
    );
    expect(scripts?.test?.errors).toEqual([]);
    expect(scripts?.test?.tests?.map((t) => t.passed)).toEqual([true, true, true, true]);
  });

  it('applies pre-request metadata edits to the outgoing call', async () => {
    await run(
      grpcReq({
        preRequestScript: `
          rs.request.metadata['x-added'] = 'yes';
          rs.request.metadata['x-tenant'] = rs.request.metadata['x-tenant'] + '-2';
        `,
      })
    );
    const sent = call().mock.calls[0]![0] as GrpcRequest;
    const enabled = sent.metadata.filter((m) => m.enabled).map((m) => [m.key, m.value]);
    expect(enabled).toEqual([
      ['X-Tenant', 'acme-2'],
      ['x-added', 'yes'],
    ]);
  });

  it('sends the original request when the script does not touch metadata', async () => {
    const req = grpcReq({ preRequestScript: `rs.environment.set('k', 'v');` });
    await run(req);
    expect((call().mock.calls[0]![0] as GrpcRequest).metadata).toBe(req.metadata);
  });
});
