import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRouterTransport, ConnectError, Code, type Transport } from '@connectrpc/connect';
import { registryFromProtoText } from '@shared/protocol/grpc-registry';

// grpc-connect imports secret-handle-store (which loads electron/electron-store
// at module init). The executor only needs unwrapSecretValueMain on the TLS
// path, which these injected-transport tests never hit — stub it out so the
// import chain stays clean.
vi.mock('../secret-handle-store', () => ({
  unwrapSecretValueMain: (v: unknown) => (typeof v === 'string' ? v : undefined),
}));

import {
  executeConnectUnary,
  runConnectStream,
  executeConnectServerStreamCollect,
  executeConnectReflection,
  reflectionProto,
  type ConnectStreamHandlers,
} from '../grpc-connect';

const ECHO_PROTO = readFileSync(resolve(__dirname, '../../../e2e/mocks/proto/echo.proto'), 'utf8');
const SERVICE = 'echo.v1.EchoService';

type UnaryImpl = (
  req: { message: string; count: number },
  ctx: { requestHeader: Headers; responseHeader: Headers; responseTrailer: Headers }
) => Promise<{ message: string; index: number }> | { message: string; index: number };

function echoTransport(unaryEcho: UnaryImpl): Transport {
  const service = registryFromProtoText(ECHO_PROTO).getService(SERVICE)!;
  const notImpl = async () => {
    throw new ConnectError('unimplemented', Code.Unimplemented);
  };
  const impl = {
    unaryEcho,
    serverStreamingEcho: notImpl,
    clientStreamingEcho: notImpl,
    bidirectionalEcho: notImpl,
  };
  return createRouterTransport((router) => {
    router.service(service, impl as never);
  });
}

const baseArgs = {
  url: 'https://echo.example.com',
  dial: { ip: '127.0.0.1', port: 443, family: 4 as const },
  service: SERVICE,
  method: 'UnaryEcho',
  protoContent: ECHO_PROTO,
  message: { message: 'hi' },
  metadata: {} as Record<string, string>,
};

describe('executeConnectUnary', () => {
  it('returns OK with the response message + headers + trailers', async () => {
    const transport = echoTransport((req, ctx) => {
      ctx.responseHeader.set('x-h', '1');
      ctx.responseTrailer.set('x-t', '2');
      return { message: `echo: ${req.message}`, index: 0 };
    });
    const r = await executeConnectUnary({ ...baseArgs, transport });
    expect(r.status).toBe(0);
    expect(r.statusText).toBe('OK');
    expect(r.message).toEqual({ message: 'echo: hi', index: 0 });
    expect(r.headers['x-h']).toBe('1');
    expect(r.trailers['x-t']).toBe('2');
    expect(r.error).toBeUndefined();
  });

  it('maps a gRPC error to a non-OK status without throwing', async () => {
    const transport = echoTransport(() => {
      throw new ConnectError('nope', Code.PermissionDenied);
    });
    const r = await executeConnectUnary({ ...baseArgs, transport });
    expect(r.status).toBe(Code.PermissionDenied); // 7
    expect(r.error).toBe('nope');
  });

  it('forwards request metadata as gRPC headers', async () => {
    let seen: string | null = null;
    const transport = echoTransport((_req, ctx) => {
      seen = ctx.requestHeader.get('x-echo-token');
      return { message: 'ok', index: 0 };
    });
    await executeConnectUnary({ ...baseArgs, transport, metadata: { 'x-echo-token': 'abc' } });
    expect(seen).toBe('abc');
  });

  it('throws a setup error for a non-unary method', async () => {
    await expect(
      executeConnectUnary({
        ...baseArgs,
        method: 'ServerStreamingEcho',
        transport: echoTransport(() => ({ message: '', index: 0 })),
      })
    ).rejects.toThrow(/not a unary method/);
  });

  it('throws a setup error when no schema is provided', async () => {
    const { protoContent: _omit, ...noSchema } = baseArgs;
    await expect(
      executeConnectUnary({
        ...noSchema,
        transport: echoTransport(() => ({ message: '', index: 0 })),
      })
    ).rejects.toThrow(/No proto source/);
  });
});

// --- streaming -------------------------------------------------------------

type RouterImpls = Record<string, unknown>;

function echoStreamTransport(impls: RouterImpls): Transport {
  const service = registryFromProtoText(ECHO_PROTO).getService(SERVICE)!;
  const notImpl = async () => {
    throw new ConnectError('unimplemented', Code.Unimplemented);
  };
  const base = {
    unaryEcho: notImpl,
    serverStreamingEcho: notImpl,
    clientStreamingEcho: notImpl,
    bidirectionalEcho: notImpl,
  };
  return createRouterTransport((router) => {
    router.service(service, { ...base, ...impls } as never);
  });
}

interface Sink {
  messages: unknown[];
  headers: Record<string, string>;
  trailers: Record<string, string>;
  closed: { code: number; details: string } | null;
  cancelled: boolean;
}

function makeSink(): { sink: Sink; handlers: ConnectStreamHandlers } {
  const sink: Sink = { messages: [], headers: {}, trailers: {}, closed: null, cancelled: false };
  return {
    sink,
    handlers: {
      onMessage: (m) => sink.messages.push(m),
      onHeaders: (h) => Object.assign(sink.headers, h),
      onTrailers: (t) => Object.assign(sink.trailers, t),
      onClose: (code, details) => {
        sink.closed = { code, details };
      },
      onCancelled: () => {
        sink.cancelled = true;
      },
    },
  };
}

const streamBase = {
  url: 'https://echo.example.com',
  dial: { ip: '127.0.0.1', port: 443, family: 4 as const },
  service: SERVICE,
  protoContent: ECHO_PROTO,
  metadata: {} as Record<string, string>,
  message: {} as unknown,
};

describe('runConnectStream', () => {
  it('server-streaming: iterates messages, captures headers + trailers, closes OK', async () => {
    const { sink, handlers } = makeSink();
    const transport = echoStreamTransport({
      serverStreamingEcho: async function* (
        req: { message: string; count: number },
        ctx: {
          responseHeader: Headers;
          responseTrailer: Headers;
        }
      ) {
        ctx.responseHeader.set('x-h', '1');
        ctx.responseTrailer.set('x-t', '2');
        for (let i = 0; i < req.count; i++) yield { message: `echo: ${req.message}`, index: i };
      },
    });

    runConnectStream(
      {
        ...streamBase,
        method: 'ServerStreamingEcho',
        message: { message: 'hi', count: 2 },
        transport,
      },
      handlers
    );
    await vi.waitFor(() => {
      if (!sink.closed) throw new Error('pending');
    });
    expect(sink.messages).toEqual([
      { message: 'echo: hi', index: 0 },
      { message: 'echo: hi', index: 1 },
    ]);
    expect(sink.headers['x-h']).toBe('1');
    expect(sink.trailers['x-t']).toBe('2');
    expect(sink.closed).toEqual({ code: 0, details: 'OK' });
  });

  it('client-streaming: writes are summarised into the single response', async () => {
    const { sink, handlers } = makeSink();
    const transport = echoStreamTransport({
      clientStreamingEcho: async (reqs: AsyncIterable<{ message: string }>) => {
        const parts: string[] = [];
        for await (const r of reqs) parts.push(r.message);
        return { messageCount: parts.length, concatenated: parts.join('|') };
      },
    });

    const controls = runConnectStream(
      { ...streamBase, method: 'ClientStreamingEcho', transport },
      handlers
    );
    controls.write({ message: 'a' });
    controls.write({ message: 'b' });
    controls.write({ message: 'c' });
    controls.end();

    await vi.waitFor(() => {
      if (!sink.closed) throw new Error('pending');
    });
    expect(sink.messages).toEqual([{ messageCount: 3, concatenated: 'a|b|c' }]);
    expect(sink.closed?.code).toBe(0);
  });

  it('bidi: each write gets an echo back, closes OK on end', async () => {
    const { sink, handlers } = makeSink();
    const transport = echoStreamTransport({
      bidirectionalEcho: async function* (reqs: AsyncIterable<{ message: string }>) {
        let i = 0;
        for await (const r of reqs) yield { message: `echo: ${r.message}`, index: i++ };
      },
    });

    const controls = runConnectStream(
      { ...streamBase, method: 'BidirectionalEcho', transport },
      handlers
    );
    controls.write({ message: 'x' });
    controls.write({ message: 'y' });
    await vi.waitFor(() => {
      if (sink.messages.length < 2) throw new Error('pending');
    });
    controls.end();
    await vi.waitFor(() => {
      if (!sink.closed) throw new Error('pending');
    });
    expect(sink.messages).toEqual([
      { message: 'echo: x', index: 0 },
      { message: 'echo: y', index: 1 },
    ]);
    expect(sink.closed?.code).toBe(0);
  });

  it('maps a server error to a non-OK close (not a cancel)', async () => {
    const { sink, handlers } = makeSink();
    const transport = echoStreamTransport({
      // eslint-disable-next-line require-yield
      serverStreamingEcho: async function* () {
        throw new ConnectError('boom', Code.FailedPrecondition);
      },
    });
    runConnectStream(
      {
        ...streamBase,
        method: 'ServerStreamingEcho',
        message: { message: 'x', count: 1 },
        transport,
      },
      handlers
    );
    await vi.waitFor(() => {
      if (!sink.closed) throw new Error('pending');
    });
    expect(sink.closed?.code).toBe(Code.FailedPrecondition); // 9
    expect(sink.cancelled).toBe(false);
  });

  it('cancel(): fires onCancelled and no terminal close', async () => {
    const { sink, handlers } = makeSink();
    const transport = echoStreamTransport({
      serverStreamingEcho: async function* (_req: unknown, ctx: { signal: AbortSignal }) {
        yield { message: 'first', index: 0 };
        await new Promise<void>((res) => {
          if (ctx.signal.aborted) res();
          else ctx.signal.addEventListener('abort', () => res());
        });
      },
    });
    const controls = runConnectStream(
      {
        ...streamBase,
        method: 'ServerStreamingEcho',
        message: { message: 'x', count: 1 },
        transport,
      },
      handlers
    );
    await vi.waitFor(() => {
      if (sink.messages.length < 1) throw new Error('pending');
    });
    controls.cancel();
    await vi.waitFor(() => {
      if (!sink.cancelled) throw new Error('pending');
    });
    expect(sink.cancelled).toBe(true);
    expect(sink.closed).toBeNull();
  });

  it('throws for a unary method (wrong entry point)', () => {
    expect(() =>
      runConnectStream(
        { ...streamBase, method: 'UnaryEcho', transport: echoStreamTransport({}) },
        makeSink().handlers
      )
    ).toThrow(/unary/i);
  });
});

describe('executeConnectServerStreamCollect', () => {
  it('collects all server-streamed messages and returns OK', async () => {
    const transport = echoStreamTransport({
      serverStreamingEcho: async function* (req: { message: string; count: number }) {
        for (let i = 0; i < req.count; i++) yield { message: `echo: ${req.message}`, index: i };
      },
    });
    const r = await executeConnectServerStreamCollect({
      ...streamBase,
      method: 'ServerStreamingEcho',
      message: { message: 'hi', count: 3 },
      transport,
    });
    expect(r.status).toBe(0);
    expect(r.messages).toEqual([
      { message: 'echo: hi', index: 0 },
      { message: 'echo: hi', index: 1 },
      { message: 'echo: hi', index: 2 },
    ]);
  });

  it('maps a server error to a non-OK status, keeping collected messages', async () => {
    const transport = echoStreamTransport({
      serverStreamingEcho: async function* () {
        yield { message: 'one', index: 0 };
        throw new ConnectError('boom', Code.Unavailable);
      },
    });
    const r = await executeConnectServerStreamCollect({
      ...streamBase,
      method: 'ServerStreamingEcho',
      message: { message: 'x', count: 1 },
      transport,
    });
    expect(r.status).toBe(Code.Unavailable); // 14
    expect(r.messages).toEqual([{ message: 'one', index: 0 }]);
    expect(r.error).toBe('boom');
  });
});

// --- reflection ------------------------------------------------------------

function reflectionTransport(
  serverReflectionInfo: (
    reqs: AsyncIterable<Record<string, unknown>>
  ) => AsyncGenerator<Record<string, unknown>>
): Transport {
  const service = registryFromProtoText(reflectionProto('v1')).getService(
    'grpc.reflection.v1.ServerReflection'
  )!;
  return createRouterTransport((router) => {
    router.service(service, { serverReflectionInfo } as never);
  });
}

const reflBase = {
  url: 'grpc://localhost:50051',
  dial: { ip: '127.0.0.1', port: 50051, family: 4 as const },
  version: 'v1' as const,
  timeoutMs: 5000,
};

describe('executeConnectReflection', () => {
  it('returns base64 file descriptors for a symbol query', async () => {
    const transport = reflectionTransport(async function* (reqs) {
      for await (const _req of reqs) {
        yield {
          messageResponse: {
            case: 'fileDescriptorResponse',
            value: { fileDescriptorProto: [new Uint8Array([1, 2, 3])] },
          },
        };
      }
    });
    const r = await executeConnectReflection({
      ...reflBase,
      request: { fileContainingSymbol: 'echo.v1.EchoService' },
      transport,
    });
    expect(r.fileDescriptorResponse?.fileDescriptorProto).toEqual(['AQID']); // base64 of 0x01 0x02 0x03
  });

  it('returns the service list for a listServices query', async () => {
    const transport = reflectionTransport(async function* (reqs) {
      for await (const _req of reqs) {
        yield {
          messageResponse: {
            case: 'listServicesResponse',
            value: { service: [{ name: 'echo.v1.EchoService' }] },
          },
        };
      }
    });
    const r = await executeConnectReflection({
      ...reflBase,
      request: { listServices: '*' },
      transport,
    });
    expect(r.listServicesResponse?.service).toEqual([{ name: 'echo.v1.EchoService' }]);
  });

  it('surfaces a reflection error response', async () => {
    const transport = reflectionTransport(async function* (reqs) {
      for await (const _req of reqs) {
        yield {
          messageResponse: {
            case: 'errorResponse',
            value: { errorCode: 5, errorMessage: 'not found' },
          },
        };
      }
    });
    const r = await executeConnectReflection({
      ...reflBase,
      request: { fileContainingSymbol: 'nope' },
      transport,
    });
    expect(r.errorResponse).toEqual({ errorCode: 5, errorMessage: 'not found' });
  });
});
