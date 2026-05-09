import { test, expect } from './fixtures/servers';
import { createConnectTransport, createGrpcTransport } from '@connectrpc/connect-node';
import { createClient, ConnectError, Code } from '@connectrpc/connect';
import { create } from '@bufbuild/protobuf';
import { EchoService, EchoRequestSchema } from './mocks/proto/gen/echo_pb';
import { FAIL_TRIGGERS, slowMessage } from './mocks/grpcServer';

/**
 * Advanced gRPC scenarios: error code mapping, metadata propagation
 * (headers + trailers), deadline / cancellation, and authenticated calls.
 *
 * These exercise the parts of Restura's gRPC handler that are easiest to
 * break: the worker's status-code mapping, the renderer's metadata builder,
 * and the streaming client's abort plumbing.
 */
test.describe('gRPC — error codes', () => {
  test('Worker proxy maps NOT_FOUND from the server', async ({ request, servers }) => {
    const res = await request.post('http://localhost:5173/api/grpc', {
      data: {
        url: servers.grpc.url,
        service: 'echo.v1.EchoService',
        method: 'UnaryEcho',
        message: { message: FAIL_TRIGGERS.NotFound },
        timeout: 10_000,
      },
    });
    const json = (await res.json()) as { grpcStatus: number; data: { error?: string } };
    expect(json.grpcStatus).toBe(Code.NotFound);
    expect(JSON.stringify(json.data)).toContain(FAIL_TRIGGERS.NotFound);
  });

});

test.describe('gRPC — Connect error codes via SDK client', () => {
  for (const [trigger, expectedCode] of [
    [FAIL_TRIGGERS.InvalidArgument, Code.InvalidArgument],
    [FAIL_TRIGGERS.PermissionDenied, Code.PermissionDenied],
    [FAIL_TRIGGERS.Unauthenticated, Code.Unauthenticated],
    [FAIL_TRIGGERS.Unavailable, Code.Unavailable],
    [FAIL_TRIGGERS.Internal, Code.Internal],
    [FAIL_TRIGGERS.Unimplemented, Code.Unimplemented],
  ] as const) {
    test(`unary ${trigger} surfaces as ConnectError(${Code[expectedCode]})`, async ({ servers }) => {
      const transport = createConnectTransport({
        baseUrl: servers.grpc.url,
        httpVersion: '1.1',
      });
      const client = createClient(EchoService, transport);
      const error = await client
        .unaryEcho(create(EchoRequestSchema, { message: trigger, count: 0 }))
        .then(() => null)
        .catch((e) => e);
      expect(error).toBeInstanceOf(ConnectError);
      expect((error as ConnectError).code).toBe(expectedCode);
    });
  }
});

test.describe('gRPC — metadata propagation', () => {
  test('inbound x-echo-* headers mirror onto response headers', async ({ servers }) => {
    const transport = createConnectTransport({
      baseUrl: servers.grpc.url,
      httpVersion: '1.1',
    });
    const client = createClient(EchoService, transport);

    // The contextValues / metadata appear on the call's `header` callback.
    const headerSeen: Record<string, string> = {};
    await client.unaryEcho(create(EchoRequestSchema, { message: 'metadata', count: 0 }), {
      headers: { 'x-echo-trace': 'abc-123', 'x-echo-tenant': 'acme' },
      onHeader(headers) { headers.forEach((v, k) => { headerSeen[k.toLowerCase()] = v; }); },
    });
    expect(headerSeen['x-echo-trace']).toBe('abc-123');
    expect(headerSeen['x-echo-tenant']).toBe('acme');
  });

  test('server-streaming yields a trailer with x-echo-count', async ({ servers }) => {
    const transport = createConnectTransport({
      baseUrl: servers.grpc.url,
      httpVersion: '1.1',
    });
    const client = createClient(EchoService, transport);

    const trailers: Record<string, string> = {};
    const replies: number[] = [];
    const stream = client.serverStreamingEcho(
      create(EchoRequestSchema, { message: 'tick', count: 4 }),
      {
        onTrailer(t) {
          t.forEach((v, k) => { trailers[k.toLowerCase()] = v; });
        },
      }
    );
    for await (const r of stream) replies.push(r.index);
    expect(replies).toEqual([0, 1, 2, 3]);
    expect(trailers['x-echo-count']).toBe('4');
  });
});

test.describe('gRPC — deadline / cancellation', () => {
  test('client AbortSignal cancels a slow server-streaming RPC', async ({ servers }) => {
    const transport = createConnectTransport({
      baseUrl: servers.grpc.url,
      httpVersion: '1.1',
    });
    const client = createClient(EchoService, transport);

    const ac = new AbortController();
    const stream = client.serverStreamingEcho(
      create(EchoRequestSchema, { message: slowMessage(200, 'slow-tick'), count: 5 }),
      { signal: ac.signal }
    );

    const collected: number[] = [];
    const consume = (async () => {
      try {
        for await (const r of stream) {
          collected.push(r.index);
          if (collected.length === 1) ac.abort();
        }
      } catch (err) {
        if (err instanceof ConnectError && err.code !== Code.Canceled) throw err;
      }
    })();

    await consume;
    expect(collected.length).toBeLessThan(5);
  });

  test('extremely tight timeoutMs yields a deadline-related ConnectError', async ({ servers }) => {
    const transport = createConnectTransport({
      baseUrl: servers.grpc.url,
      httpVersion: '1.1',
    });
    const client = createClient(EchoService, transport);

    const error = await (async () => {
      try {
        for await (const _ of client.serverStreamingEcho(
          create(EchoRequestSchema, { message: slowMessage(500, 'body'), count: 3 }),
          { timeoutMs: 50 }
        )) { void _; }
        return null;
      } catch (e) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(ConnectError);
    const code = (error as ConnectError).code;
    // Deadline tripped: depending on where it lands the SDK reports
    // DeadlineExceeded, Canceled, or Aborted. All are valid signals.
    expect([Code.DeadlineExceeded, Code.Canceled, Code.Aborted, Code.Unavailable]).toContain(code);
  });
});

test.describe('gRPC — bidirectional with metadata', () => {
  test('bidi propagates request headers and emits trailer on completion', async ({ servers }) => {
    const transport = createGrpcTransport({ baseUrl: servers.grpc.h2cUrl });
    const client = createClient(EchoService, transport);

    async function* inputs() {
      yield create(EchoRequestSchema, { message: 'a', count: 0 });
      yield create(EchoRequestSchema, { message: 'b', count: 0 });
    }

    const trailers: Record<string, string> = {};
    const replies: string[] = [];
    const stream = client.bidirectionalEcho(inputs(), {
      headers: { 'x-echo-flow': 'bidi-1' },
      onTrailer(t) {
        t.forEach((v, k) => { trailers[k.toLowerCase()] = v; });
      },
    });
    for await (const r of stream) replies.push(r.message);
    expect(replies).toEqual(['echo: a', 'echo: b']);
    expect(trailers['x-echo-count']).toBe('2');
  });
});
