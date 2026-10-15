/**
 * #917 — the transport half of the streaming runner: outbound message parsing,
 * schema/option forwarding to `startGrpcStream`, abort handling and the
 * aggregated response for each stream shape. Only the transport is faked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GrpcRequest } from '@/types';
import { GrpcStatusCode } from '@/types';
import type {
  GrpcStreamFinal,
  GrpcStreamingHandle,
  StartGrpcStreamArgs,
} from '../grpcStreamingClient';

const startCalls: StartGrpcStreamArgs[] = [];
let nextHandle: () => GrpcStreamingHandle;

vi.mock('../grpcStreamingClient', () => ({
  startGrpcStream: async (args: StartGrpcStreamArgs) => {
    startCalls.push(args);
    return nextHandle();
  },
}));

import { outboundMessages, runGrpcStreamCall } from '../grpcStreamRun';

function handleOf(inbound: unknown[], final: GrpcStreamFinal) {
  const sent: unknown[] = [];
  const handle = {
    messages: (async function* () {
      yield* inbound;
    })(),
    send: vi.fn(async (m: unknown) => {
      sent.push(m);
    }),
    closeSend: vi.fn(),
    cancel: vi.fn(),
    done: Promise.resolve(final),
  };
  return { handle, sent };
}

function request(overrides: Partial<GrpcRequest> = {}): GrpcRequest {
  return {
    id: 'req-1',
    name: 'Call',
    type: 'grpc',
    methodType: 'server-streaming',
    url: 'https://grpc.example.com',
    service: 'svc.v1.Svc',
    method: 'Call',
    metadata: [],
    message: '{}',
    auth: { type: 'none' },
    ...overrides,
  };
}

const identity = (t: string) => t;
const ok: GrpcStreamFinal = {
  headers: { h: '1' },
  trailers: { t: '2' },
  status: GrpcStatusCode.OK,
};

beforeEach(() => {
  startCalls.length = 0;
});

describe('outboundMessages', () => {
  it('sends nothing for a blank message, one per array element otherwise', () => {
    expect(outboundMessages('  ', identity)).toEqual([]);
    expect(outboundMessages('[{"a":1},{"a":2}]', identity)).toEqual([{ a: 1 }, { a: 2 }]);
    expect(outboundMessages('{"a":{{n}}}', (t) => t.replace('{{n}}', '3'))).toEqual([{ a: 3 }]);
  });

  it('reports invalid JSON before any stream is opened', () => {
    expect(() => outboundMessages('{oops', identity)).toThrow(/^Invalid JSON in request message: /);
    expect(() =>
      outboundMessages('x', () => {
        throw 'resolver exploded';
      })
    ).toThrow('Invalid JSON in request message: resolver exploded');
  });
});

describe('runGrpcStreamCall', () => {
  it('forwards the schema and call options to the transport', async () => {
    nextHandle = () => handleOf([], ok).handle;
    await runGrpcStreamCall({
      request: request(),
      resolveVariables: identity,
      signal: new AbortController().signal,
      protoContent: 'syntax = "proto3";',
      protoFileName: 'svc.proto',
      descriptors: ['AAA='],
      timeoutMs: 0,
      useCompression: false,
    });
    expect(startCalls[0]).toMatchObject({
      protoContent: 'syntax = "proto3";',
      protoFileName: 'svc.proto',
      descriptors: ['AAA='],
      timeoutMs: 0,
      useCompression: false,
    });

    await runGrpcStreamCall({
      request: request(),
      resolveVariables: identity,
      signal: new AbortController().signal,
      descriptors: [],
    });
    expect(Object.keys(startCalls[1] ?? {}).sort()).toEqual(['request', 'resolveVariables']);
  });

  it('refuses to open a stream for an already-aborted run', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runGrpcStreamCall({
        request: request(),
        resolveVariables: identity,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(startCalls).toHaveLength(0);
  });

  it('auto-sends and half-closes a client stream, showing its single reply as the body', async () => {
    const fake = handleOf([{ total: 3 }], ok);
    nextHandle = () => fake.handle;
    const { response, messages } = await runGrpcStreamCall({
      request: request({ methodType: 'client-streaming', message: '[{"n":1},{"n":2}]' }),
      resolveVariables: identity,
      signal: new AbortController().signal,
    });
    expect(fake.sent).toEqual([{ n: 1 }, { n: 2 }]);
    expect(fake.handle.closeSend).toHaveBeenCalled();
    expect(messages).toEqual([{ total: 3 }]);
    expect(JSON.parse(response.body)).toEqual({ total: 3 });
    expect(response).toMatchObject({
      grpcStatus: GrpcStatusCode.OK,
      statusText: 'OK',
      headers: { h: '1' },
      trailers: { t: '2' },
      messages: ['{"total":3}'],
      isStreaming: true,
    });
    expect(response.statusDetails).toBeUndefined();
  });

  it('reports a message-less failure as an error body with its details', async () => {
    const statusDetails = [{ type: 'google.rpc.ErrorInfo', value: { reason: 'R' } }];
    nextHandle = () =>
      handleOf([], {
        headers: {},
        trailers: {},
        status: GrpcStatusCode.UNAVAILABLE,
        statusDetails,
      }).handle;
    const { response } = await runGrpcStreamCall({
      request: request(),
      resolveVariables: identity,
      signal: new AbortController().signal,
    });
    expect(response.grpcStatusText).toBe('UNAVAILABLE');
    expect(JSON.parse(response.body)).toEqual({ error: 'UNAVAILABLE' });
    expect(response.statusDetails).toEqual(statusDetails);

    nextHandle = () =>
      handleOf([], { headers: {}, trailers: {}, status: 99 as GrpcStatusCode }).handle;
    const unknown = await runGrpcStreamCall({
      request: request(),
      resolveVariables: identity,
      signal: new AbortController().signal,
    });
    expect(unknown.response.statusText).toBe('UNKNOWN');
  });

  it('cancels the call when the run is aborted mid-stream', async () => {
    const controller = new AbortController();
    const fake = handleOf([], ok);
    let release!: () => void;
    fake.handle.messages = (async function* () {
      await new Promise<void>((r) => {
        release = r;
      });
    })();
    fake.handle.cancel.mockImplementation(() => release());
    nextHandle = () => fake.handle;
    const pending = runGrpcStreamCall({
      request: request(),
      resolveVariables: identity,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    controller.abort();
    await pending;
    expect(fake.handle.cancel).toHaveBeenCalled();
  });
});
