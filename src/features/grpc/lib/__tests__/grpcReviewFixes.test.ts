// Regression tests for the gRPC protocol review fixes: error bodies on the
// desktop unary path, the web relay's own `{ error }` replies, binary (-bin)
// metadata, and `{{variable}}` service / method / URL resolution.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GrpcRequest } from '@/types';
import { GrpcStatusCode } from '@/types';
import { makeElectronGrpcRequest, makeProxyGrpcRequest, prepareGrpcRequest } from '../grpcClient';
import { startGrpcStream } from '../grpcStreamingClient';

const base: GrpcRequest = {
  id: 'r1',
  name: 'Test',
  type: 'grpc',
  methodType: 'unary',
  url: 'https://grpc.example.com',
  service: 'echo.v1.EchoService',
  method: 'UnaryEcho',
  metadata: [],
  message: '{}',
  auth: { type: 'none' },
};

function setElectron(grpc: Record<string, unknown> | undefined): void {
  Object.defineProperty(window, 'electron', {
    value: grpc ? { isElectron: true, grpc } : undefined,
    writable: true,
    configurable: true,
  });
}

afterEach(() => {
  setElectron(undefined);
  vi.unstubAllGlobals();
});

describe('desktop unary: a failed call explains itself in the body', () => {
  it('puts the server / policy error text into the body (web relay shape)', async () => {
    const request = vi.fn().mockResolvedValue({
      status: GrpcStatusCode.FAILED_PRECONDITION,
      statusText: 'FAILED_PRECONDITION',
      headers: {},
      trailers: { 'grpc-message': 'order 42 is locked' },
      error: 'order 42 is locked',
    });
    setElectron({ request });
    const res = await makeElectronGrpcRequest(base, 'syntax = "proto3";', 'x.proto', (s) => s);
    expect(res.grpcStatus).toBe(GrpcStatusCode.FAILED_PRECONDITION);
    expect(JSON.parse(res.body)).toEqual({ error: 'order 42 is locked' });
  });

  it('keeps distinct details next to the error', async () => {
    const request = vi.fn().mockResolvedValue({
      status: GrpcStatusCode.INVALID_ARGUMENT,
      statusText: 'INVALID_ARGUMENT',
      headers: {},
      trailers: {},
      error: '[URL policy] blocked',
      details: '[URL policy] host resolves to a private address',
    });
    setElectron({ request });
    const res = await makeElectronGrpcRequest(base, 'syntax = "proto3";', 'x.proto', (s) => s);
    expect(JSON.parse(res.body)).toEqual({
      error: '[URL policy] blocked',
      details: '[URL policy] host resolves to a private address',
    });
  });

  it('falls back to the status name when the main process sent no text', async () => {
    const request = vi.fn().mockResolvedValue({
      status: GrpcStatusCode.UNAVAILABLE,
      statusText: 'UNAVAILABLE',
      headers: {},
      trailers: {},
    });
    setElectron({ request });
    const res = await makeElectronGrpcRequest(base, 'syntax = "proto3";', 'x.proto', (s) => s);
    expect(JSON.parse(res.body)).toEqual({ error: 'UNAVAILABLE' });
  });

  it('an OK call still renders the message', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 0,
      statusText: 'OK',
      headers: {},
      trailers: {},
      message: { message: 'echo: hi', index: 0 },
    });
    setElectron({ request });
    const res = await makeElectronGrpcRequest(base, 'syntax = "proto3";', 'x.proto', (s) => s);
    expect(JSON.parse(res.body)).toEqual({ message: 'echo: hi', index: 0 });
  });
});

describe('web unary: the relay’s own rejections', () => {
  const stubFetch = (status: number, body: string, ct = 'application/json') =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status, headers: { 'content-type': ct } }))
    );

  it.each([
    [400, '{"error":"Invalid URL: Private IP addresses are not allowed"}', 3],
    [401, '{"error":"Unauthorized"}', GrpcStatusCode.UNAUTHENTICATED],
    [413, '{"error":"Request body too large"}', GrpcStatusCode.RESOURCE_EXHAUSTED],
    [429, '{"error":"Rate limit exceeded"}', GrpcStatusCode.RESOURCE_EXHAUSTED],
  ])('HTTP %i `{ error }` → a real gRPC status and the message', async (status, body, code) => {
    stubFetch(status, body);
    const res = await makeProxyGrpcRequest(base, (s) => s);
    expect(res.grpcStatus).toBe(code);
    expect(typeof res.grpcStatusText).toBe('string');
    expect(JSON.parse(res.body).error).toBe(JSON.parse(body).error);
  });

  it('a non-JSON relay reply becomes an error response, not a throw', async () => {
    stubFetch(502, '<html>Bad gateway</html>', 'text/html');
    const res = await makeProxyGrpcRequest(base, (s) => s);
    expect(res.grpcStatus).toBe(GrpcStatusCode.UNAVAILABLE);
    expect(JSON.parse(res.body).error).toMatch(/non-JSON HTTP 502/);
  });

  it('an upstream status from the relay is passed through unchanged', async () => {
    stubFetch(
      200,
      JSON.stringify({
        grpcStatus: GrpcStatusCode.UNIMPLEMENTED,
        grpcStatusText: 'UNIMPLEMENTED',
        headers: {},
        trailers: {},
        data: { error: 'HTTP 404' },
        size: 0,
      })
    );
    const res = await makeProxyGrpcRequest(base, (s) => s);
    expect(res.grpcStatus).toBe(GrpcStatusCode.UNIMPLEMENTED);
    expect(JSON.parse(res.body)).toEqual({ error: 'HTTP 404' });
  });
});

describe('binary (-bin) metadata', () => {
  it('base64-encodes text values and keeps base64 values as typed', () => {
    const prepared = prepareGrpcRequest(
      {
        ...base,
        metadata: [
          { id: '1', key: 'trace-bin', value: 'hello world', enabled: true },
          { id: '2', key: 'raw-bin', value: 'AAEC', enabled: true },
          { id: '3', key: 'x-plain', value: 'hello world', enabled: true },
        ],
      },
      (s) => s
    );
    expect(prepared.metadata['trace-bin']).toBe(btoa('hello world'));
    expect(prepared.metadata['raw-bin']).toBe('AAEC');
    expect(prepared.metadata['x-plain']).toBe('hello world');
  });
});

describe('{{variable}} service / method / URL in streams', () => {
  const vars: Record<string, string> = {
    baseUrl: 'https://grpc.example.com',
    svc: 'echo.v1.EchoService',
    rpc: 'ServerStreamingEcho',
  };
  const resolve = (t: string) => t.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');

  it('validates the resolved values, not the raw template', async () => {
    // Without a schema the call stops at the schema check — i.e. it got past
    // URL / service / method validation, which used to reject `{{baseUrl}}`.
    await expect(
      startGrpcStream({
        request: {
          ...base,
          methodType: 'server-streaming',
          url: '{{baseUrl}}',
          service: '{{svc}}',
          method: '{{rpc}}',
        },
        resolveVariables: resolve,
      })
    ).rejects.toThrow(/needs a schema/);
  });

  it('still rejects a template that resolves to an invalid URL', async () => {
    await expect(
      startGrpcStream({
        request: { ...base, methodType: 'server-streaming', url: '{{missing}}' },
        resolveVariables: resolve,
      })
    ).rejects.toThrow(/URL is required/);
  });
});

describe('{{variable}} service / method on the unary send path', () => {
  it('resolves them before building /{service}/{method}', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            grpcStatus: 0,
            grpcStatusText: 'OK',
            data: {},
            headers: {},
            trailers: {},
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    );
    vi.stubGlobal('fetch', fetchSpy);
    const { grpcProtocol } = await import('../../protocol');
    await grpcProtocol.runRequest(
      { ...base, url: '{{baseUrl}}', service: '{{svc}}', method: '{{rpc}}' },
      {
        signal: new AbortController().signal,
        variables: {
          baseUrl: 'https://grpc.example.com',
          svc: 'echo.v1.EchoService',
          rpc: 'UnaryEcho',
        },
      }
    );
    const init = (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1];
    const sent = JSON.parse(String(init.body));
    expect(sent).toMatchObject({
      url: 'https://grpc.example.com',
      service: 'echo.v1.EchoService',
      method: 'UnaryEcho',
    });
  });
});
