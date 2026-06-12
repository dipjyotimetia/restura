import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRouterTransport, ConnectError, Code, type Transport } from '@connectrpc/connect';
import { registryFromProtoText } from '@shared/protocol/grpc-registry';
import { startGrpcStream, createInteractiveGrpcStreamForTest } from '../grpcStreamingClient';
import type { GrpcRequest } from '@/types';
import { GrpcStatusCode } from '@/types';

const ECHO_PROTO = readFileSync(
  resolve(__dirname, '../../../../../e2e/mocks/proto/echo.proto'),
  'utf8'
);

const baseRequest: GrpcRequest = {
  id: 'r1',
  name: 'Echo',
  type: 'grpc',
  methodType: 'server-streaming',
  url: 'https://echo.example.com',
  service: 'echo.v1.EchoService',
  method: 'ServerStreamingEcho',
  metadata: [],
  message: '{"message":"hi","count":3}',
  auth: { type: 'none' },
};

type SsHandler = (
  req: { message: string; count: number },
  ctx: { signal: AbortSignal; responseHeader: Headers; responseTrailer: Headers }
) => AsyncGenerator<{ message: string; index: number }>;

/**
 * Build an in-memory ConnectRPC transport implementing echo.v1.EchoService,
 * with a custom server-streaming handler. The other three methods are stubbed
 * (never called) so router registration succeeds.
 */
function echoTransport(serverStreamingEcho: SsHandler): Transport {
  const service = registryFromProtoText(ECHO_PROTO).getService('echo.v1.EchoService')!;
  const notImpl = async () => {
    throw new ConnectError('unimplemented', Code.Unimplemented);
  };
  const impl = {
    unaryEcho: notImpl,
    clientStreamingEcho: notImpl,
    bidirectionalEcho: notImpl,
    serverStreamingEcho,
  };
  return createRouterTransport((router) => {
    router.service(service, impl as never);
  });
}

describe('startGrpcStream — validation', () => {
  it('throws for client-streaming in web mode with desktop-only message', async () => {
    await expect(
      startGrpcStream({
        request: { ...baseRequest, methodType: 'client-streaming' },
        resolveVariables: (s) => s,
      })
    ).rejects.toThrow(/desktop app only/);
  });

  it('throws for bidirectional-streaming in web mode with desktop-only message', async () => {
    await expect(
      startGrpcStream({
        request: { ...baseRequest, methodType: 'bidirectional-streaming' },
        resolveVariables: (s) => s,
      })
    ).rejects.toThrow(/desktop app only/);
  });

  it('throws on invalid JSON in message', async () => {
    await expect(
      startGrpcStream({
        request: { ...baseRequest, message: '{not json}' },
        resolveVariables: (s) => s,
        protoContent: ECHO_PROTO,
      })
    ).rejects.toThrow(/Invalid JSON/);
  });

  it('rejects an invalid URL before opening the stream', async () => {
    await expect(
      startGrpcStream({
        request: { ...baseRequest, url: 'notaurl' },
        resolveVariables: (s) => s,
      })
    ).rejects.toThrow();
  });

  it('requires a schema (descriptors or proto) for the web path', async () => {
    await expect(
      startGrpcStream({ request: baseRequest, resolveVariables: (s) => s })
    ).rejects.toThrow(/needs a schema/);
  });
});

describe('startGrpcStream — web server-streaming via ConnectRPC', () => {
  it('iterates server-streamed messages and resolves done with OK + headers + trailers', async () => {
    const transport = echoTransport(async function* (req, ctx) {
      ctx.responseHeader.set('x-server', 'test');
      ctx.responseTrailer.set('x-trailer', 'v');
      for (let i = 0; i < req.count; i++) {
        yield { message: `echo: ${req.message}`, index: i };
      }
    });

    const handle = await startGrpcStream({
      request: baseRequest,
      resolveVariables: (s) => s,
      protoContent: ECHO_PROTO,
      transport,
    });

    const collected: unknown[] = [];
    for await (const m of handle.messages) collected.push(m);
    expect(collected).toEqual([
      { message: 'echo: hi', index: 0 },
      { message: 'echo: hi', index: 1 },
      { message: 'echo: hi', index: 2 },
    ]);

    const final = await handle.done;
    expect(final.status).toBe(GrpcStatusCode.OK);
    expect(final.headers['x-server']).toBe('test');
    expect(final.trailers['x-trailer']).toBe('v');

    expect(handle.closeSend()).toBeUndefined();
    await expect(handle.send({})).rejects.toThrow(/not supported/);
  });

  it('surfaces a non-OK gRPC status via an iterator throw and resolves done with the code', async () => {
    const transport = echoTransport(
      // eslint-disable-next-line require-yield
      async function* () {
        throw new ConnectError('no', Code.PermissionDenied);
      }
    );

    const handle = await startGrpcStream({
      request: baseRequest,
      resolveVariables: (s) => s,
      protoContent: ECHO_PROTO,
      transport,
    });

    let thrown: unknown;
    try {
      for await (const _ of handle.messages) void _;
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);

    const final = await handle.done; // resolves (never rejects) → no unhandled rejection
    expect(final.status).toBe(GrpcStatusCode.PERMISSION_DENIED);
    expect(final.statusMessage).toBe('no');
  });

  it('cancel() aborts the call and finalises with CANCELLED', async () => {
    const transport = echoTransport(async function* (_req, ctx) {
      yield { message: 'first', index: 0 };
      // Hang until the client aborts, then end cleanly.
      await new Promise<void>((res) => {
        if (ctx.signal.aborted) res();
        else ctx.signal.addEventListener('abort', () => res());
      });
    });

    const handle = await startGrpcStream({
      request: baseRequest,
      resolveVariables: (s) => s,
      protoContent: ECHO_PROTO,
      transport,
    });

    const iter = handle.messages[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.value).toEqual({ message: 'first', index: 0 });

    handle.cancel();
    const final = await handle.done;
    expect(final.status).toBe(GrpcStatusCode.CANCELLED);
  });
});

describe('createInteractiveGrpcStreamForTest', () => {
  it('supports client-streaming send and close through an injected transport', async () => {
    const writes: unknown[] = [];
    const ends: string[] = [];
    const handle = createInteractiveGrpcStreamForTest({
      methodType: 'client-streaming',
      onSend: (msg) => writes.push(msg),
      onEnd: () => ends.push('end'),
    });

    await handle.send({ id: 1 });
    await handle.send({ id: 2 });
    handle.closeSend();

    expect(writes).toEqual([{ id: 1 }, { id: 2 }]);
    expect(ends).toEqual(['end']);
  });

  it('yields inbound messages for bidi-streaming and resolves done', async () => {
    const handle = createInteractiveGrpcStreamForTest<unknown, { seq: number }>({
      methodType: 'bidirectional-streaming',
      inboundMessages: [{ seq: 1 }, { seq: 2 }],
    });

    handle.closeSend();

    const collected: { seq: number }[] = [];
    for await (const msg of handle.messages) collected.push(msg);

    expect(collected).toEqual([{ seq: 1 }, { seq: 2 }]);
    const final = await handle.done;
    expect(final.status).toBe(GrpcStatusCode.OK);
  });

  it('cancel() resolves done with CANCELLED status', async () => {
    const handle = createInteractiveGrpcStreamForTest({ methodType: 'client-streaming' });
    handle.cancel();
    const final = await handle.done;
    expect(final.status).toBe(GrpcStatusCode.CANCELLED);
  });
});

describe('startGrpcStream — Electron interactive (IPC) path', () => {
  type Listener = (...a: unknown[]) => void;

  function installElectronMock() {
    const listeners = new Map<string, Listener>();
    const grpc = {
      startStream: vi.fn(),
      sendMessage: vi.fn(),
      endStream: vi.fn(),
      cancelStream: vi.fn(),
      on: vi.fn((channel: string, cb: Listener) => listeners.set(channel, cb)),
      removeListener: vi.fn((channel: string, cb: Listener) => {
        if (listeners.get(channel) === cb) listeners.delete(channel);
      }),
    };
    Object.defineProperty(window, 'electron', {
      value: { isElectron: true, grpc },
      writable: true,
      configurable: true,
    });
    const emit = (suffix: string, payload: unknown) =>
      listeners.get(`grpc:${suffix}:r1`)?.(payload);
    return { grpc, emit };
  }

  function uninstallElectronMock() {
    Object.defineProperty(window, 'electron', {
      value: undefined,
      writable: true,
      configurable: true,
    });
  }

  const proto = 'syntax = "proto3";\nservice Foo {}';

  it('routes server-streaming through IPC, iterates data, resolves done with status + headers + trailers, and removes listeners', async () => {
    const { grpc, emit } = installElectronMock();
    try {
      const handle = await startGrpcStream({
        request: baseRequest,
        resolveVariables: (s) => s,
        protoContent: proto,
        protoFileName: 'f.proto',
        timeoutMs: 12345,
      });

      expect(grpc.startStream).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'r1', methodType: 'server-streaming', timeoutMs: 12345 })
      );
      expect(grpc.on).toHaveBeenCalledTimes(3);

      const collected: unknown[] = [];
      const iter = (async () => {
        for await (const m of handle.messages) collected.push(m);
      })();

      emit('data', { n: 1 });
      emit('data', { n: 2 });
      emit('status', {
        status: 0,
        details: 'OK',
        headers: { 'x-h': '1' },
        trailers: { 'x-t': '2' },
      });

      await iter;
      expect(collected).toEqual([{ n: 1 }, { n: 2 }]);

      const final = await handle.done;
      expect(final.status).toBe(GrpcStatusCode.OK);
      expect(final.headers['x-h']).toBe('1');
      expect(final.trailers['x-t']).toBe('2');

      expect(grpc.removeListener).toHaveBeenCalledTimes(3);
    } finally {
      uninstallElectronMock();
    }
  });

  it('surfaces a non-OK trailing status via the error channel without rejecting done', async () => {
    const { emit } = installElectronMock();
    try {
      const handle = await startGrpcStream({
        request: { ...baseRequest, methodType: 'bidirectional-streaming' },
        resolveVariables: (s) => s,
        protoContent: proto,
        protoFileName: 'f.proto',
      });

      let thrown: unknown;
      const iter = (async () => {
        try {
          for await (const _m of handle.messages) void _m;
        } catch (e) {
          thrown = e;
        }
      })();

      emit('error', { status: 9, details: 'failed precondition', trailers: { 'x-t': 'z' } });
      await iter;

      expect(thrown).toBeInstanceOf(Error);
      const final = await handle.done;
      expect(final.status).toBe(9);
      expect(final.trailers['x-t']).toBe('z');
    } finally {
      uninstallElectronMock();
    }
  });

  it('send / closeSend / cancel delegate to the IPC bridge', async () => {
    const { grpc } = installElectronMock();
    try {
      const handle = await startGrpcStream({
        request: { ...baseRequest, methodType: 'client-streaming' },
        resolveVariables: (s) => s,
        protoContent: proto,
        protoFileName: 'f.proto',
      });

      await handle.send({ chunk: 1 });
      expect(grpc.sendMessage).toHaveBeenCalledWith('r1', { chunk: 1 });

      handle.closeSend();
      expect(grpc.endStream).toHaveBeenCalledWith('r1');

      handle.cancel();
      expect(grpc.cancelStream).toHaveBeenCalledWith('r1');
    } finally {
      uninstallElectronMock();
    }
  });
});
