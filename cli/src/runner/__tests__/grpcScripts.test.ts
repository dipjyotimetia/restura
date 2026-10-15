/**
 * #910 (CLI parity) — gRPC test scripts see response metadata + trailers, and
 * pre-request `rs.request.metadata` edits reach the outgoing call.
 */
import type { GrpcRequest } from '@shared/types';
import { describe, expect, it, vi } from 'vitest';

const proxySpy = vi.hoisted(() => vi.fn());
vi.mock('@shared/protocol/grpc-proxy', () => ({
  executeGrpcProxy: (spec: unknown) => {
    proxySpy(spec);
    return Promise.resolve({
      ok: true,
      response: {
        grpcStatus: 0,
        grpcStatusText: 'OK',
        headers: { 'x-foo': 'bar' },
        trailers: { 'x-trailer': 't1' },
        data: { message: 'hi' },
        size: 16,
      },
    });
  },
}));

import type { LoadedRequest } from '../collectionLoader';
import { executeGrpc } from '../executors/grpc';
import { applyPreRequestMetadata, runPreRequestScript, runTestScript } from '../scriptRunner';

const runCtx = { collectionVars: {}, iterationData: {}, iteration: 0, iterationCount: 1 };

function item(extra: Partial<GrpcRequest> = {}): LoadedRequest {
  const request: GrpcRequest = {
    id: 'g1',
    name: 'Call',
    type: 'grpc',
    methodType: 'unary',
    url: 'http://127.0.0.1:1/',
    service: 'echo.EchoService',
    method: 'Echo',
    metadata: [{ id: 'm', key: 'x-tenant', value: '{{tenant}}', enabled: true }],
    message: '{}',
    auth: { type: 'none' },
    ...extra,
  };
  return { relativePath: 'a.grpc', folderPath: [], type: 'grpc', request };
}

describe('CLI gRPC scripts (#910)', () => {
  it('exposes response metadata and trailers to test scripts', async () => {
    const outcome = await executeGrpc(item(), {
      vars: { tenant: 'acme' },
      timeoutMs: 5000,
      allowLocalhost: true,
    });
    expect(outcome.responseTrailers).toEqual({ 'x-trailer': 't1' });
    const test = await runTestScript(
      `
      rs.test('header', () => rs.expect(rs.response.headers.get('x-foo')).to.equal('bar'));
      rs.test('trailer', () => rs.expect(rs.response.trailers.get('x-trailer')).to.equal('t1'));
      rs.test('request md', () => rs.expect(rs.request.metadata['x-tenant']).to.equal('acme'));
      `,
      item(),
      outcome,
      { tenant: 'acme' },
      runCtx
    );
    expect(test.errors).toEqual([]);
    expect(test.assertions.map((a) => a.passed)).toEqual([true, true, true]);
  });

  it('applies pre-request metadata edits to the sent request', async () => {
    const vars = { tenant: 'acme' };
    const pre = await runPreRequestScript(
      `rs.request.metadata['x-extra'] = rs.request.metadata['x-tenant'] + '!';`,
      item(),
      vars,
      runCtx
    );
    expect(pre.requestMetadata).toEqual({ 'x-tenant': 'acme', 'x-extra': 'acme!' });
    const sent = applyPreRequestMetadata(item(), pre, vars);
    proxySpy.mockClear();
    await executeGrpc(sent, { vars, timeoutMs: 5000, allowLocalhost: true });
    expect(proxySpy.mock.calls[0]?.[0]).toMatchObject({
      metadata: { 'x-tenant': 'acme', 'x-extra': 'acme!' },
    });
  });

  it('leaves the item untouched when the script made no metadata edits', async () => {
    const original = item();
    const pre = await runPreRequestScript(`console.log('hi');`, original, {}, runCtx);
    expect(applyPreRequestMetadata(original, pre, {})).toBe(original);
  });
});
