/**
 * #917 — streaming gRPC calls run through the protocol runner: pre-request
 * script, a post-stream test script over the collected messages, metadata +
 * trailers, live hooks for the interactive builder, and auto-send for
 * client / bidi streams in non-interactive (collection) runs.
 *
 * Drives the REAL protocol module + REAL QuickJS sandbox; only
 * `startGrpcStream` (the transport) is faked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  GrpcStreamFinal,
  GrpcStreamingHandle,
  StartGrpcStreamArgs,
} from '@/features/grpc/lib/grpcStreamingClient';
import type { ProtocolScriptResult, StreamRunControls } from '@/features/registry/types';
import type { GrpcRequest, GrpcResponse } from '@/types';

const startCalls: StartGrpcStreamArgs[] = [];
let nextStream: () => FakeStream;

vi.mock('@/features/grpc/lib/grpcStreamingClient', () => ({
  startGrpcStream: async (args: StartGrpcStreamArgs) => {
    startCalls.push(args);
    return nextStream().handle;
  },
}));

import { MAX_RETAINED_STREAM_MESSAGES } from '@/features/grpc/lib/streamRetention';
import { grpcProtocol } from '../protocol';

interface FakeStream {
  handle: GrpcStreamingHandle;
  sent: unknown[];
  closed: () => boolean;
  cancelled: () => boolean;
}

/** A fake handle that yields `inbound` (after closeSend for client/bidi) and settles on `final`. */
function fakeStream(
  inbound: unknown[],
  final: GrpcStreamFinal,
  opts: { waitForClose?: boolean; failWith?: string } = {}
): FakeStream {
  const sent: unknown[] = [];
  let closed = false;
  let cancelled = false;
  let releaseClose!: () => void;
  const closedP = new Promise<void>((r) => {
    releaseClose = r;
  });
  let resolveDone!: (f: GrpcStreamFinal) => void;
  const done = new Promise<GrpcStreamFinal>((r) => {
    resolveDone = r;
  });
  async function* messages() {
    if (opts.waitForClose) await closedP;
    for (const m of inbound) {
      if (cancelled) break;
      yield m;
    }
    resolveDone(cancelled ? { headers: {}, trailers: {}, status: 1 } : final);
    if (opts.failWith && !cancelled) throw new Error(opts.failWith);
  }
  return {
    sent,
    closed: () => closed,
    cancelled: () => cancelled,
    handle: {
      messages: messages(),
      send: async (m) => {
        sent.push(m);
      },
      closeSend: () => {
        closed = true;
        releaseClose();
      },
      cancel: () => {
        cancelled = true;
        releaseClose();
        resolveDone({ headers: {}, trailers: {}, status: 1, statusMessage: 'Stream cancelled' });
      },
      done,
    },
  };
}

const okFinal: GrpcStreamFinal = {
  headers: { 'x-foo': 'bar' },
  trailers: { 'x-trailer': 't1' },
  status: 0,
};

function grpcReq(extra: Partial<GrpcRequest> = {}): GrpcRequest {
  return {
    id: 'g1',
    name: 'Watch',
    type: 'grpc',
    methodType: 'server-streaming',
    url: 'http://h',
    service: 'greet.v1.GreetService',
    method: 'Watch',
    metadata: [{ id: 'm1', key: 'x-tenant', value: '{{tenant}}', enabled: true }],
    message: '{"name":"{{tenant}}"}',
    auth: { type: 'none' },
    ...extra,
  };
}

async function run(
  request: GrpcRequest,
  extra: {
    stream?: Parameters<typeof grpcProtocol.runRequest>[1]['stream'];
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {}
) {
  let scripts: ProtocolScriptResult | undefined;
  const res = (await grpcProtocol.runRequest(request, {
    signal: extra.signal ?? new AbortController().signal,
    variables: { tenant: 'acme' },
    onScriptResult: (r) => {
      scripts = r;
    },
    protocolOptions: { descriptors: ['AAA='], timeoutMs: extra.timeoutMs ?? 1234 },
    ...(extra.stream ? { stream: extra.stream } : {}),
  })) as GrpcResponse;
  return { res, scripts };
}

beforeEach(() => {
  startCalls.length = 0;
  nextStream = () => fakeStream([{ n: 1 }, { n: 2 }], okFinal);
});

describe('gRPC streaming through the protocol runner (#917)', () => {
  it('runs pre-request + test scripts around a server stream', async () => {
    const { res, scripts } = await run(
      grpcReq({
        preRequestScript: `rs.request.metadata['x-run'] = 'pre';`,
        testScript: `
          rs.test('count', () => rs.expect(rs.response.messages.count()).to.equal(2));
          rs.test('idx', () => rs.expect(rs.response.messages.idx(1).n).to.equal(2));
          rs.test('all', () => rs.expect(rs.response.messages.all()).to.deep.equal([{ n: 1 }, { n: 2 }]));
          rs.test('status', () => rs.expect(rs.response.code).to.equal(0));
          rs.test('header', () => rs.expect(rs.response.headers.get('x-foo')).to.equal('bar'));
          rs.test('trailer', () => rs.expect(rs.response.trailers.get('x-trailer')).to.equal('t1'));
          rs.test('json', () => rs.expect(rs.response.json()).to.deep.equal([{ n: 1 }, { n: 2 }]));
        `,
      })
    );
    expect(scripts?.preRequest?.errors).toEqual([]);
    expect(scripts?.test?.errors).toEqual([]);
    expect(scripts?.test?.tests?.map((t) => [t.name, t.passed])).toEqual([
      ['count', true],
      ['idx', true],
      ['all', true],
      ['status', true],
      ['header', true],
      ['trailer', true],
      ['json', true],
    ]);

    const args = startCalls[0]!;
    expect(args.descriptors).toEqual(['AAA=']);
    expect(args.timeoutMs).toBe(1234);
    expect(args.request.metadata.filter((m) => m.enabled).map((m) => m.key)).toEqual([
      'x-tenant',
      'x-run',
    ]);
    expect(args.resolveVariables('{{tenant}}')).toBe('acme');

    expect(res).toMatchObject({
      requestId: 'g1',
      grpcStatus: 0,
      grpcStatusText: 'OK',
      headers: { 'x-foo': 'bar' },
      trailers: { 'x-trailer': 't1' },
      messages: ['{"n":1}', '{"n":2}'],
      isStreaming: true,
    });
    expect(JSON.parse(res.body)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('keeps "No deadline" (0) for a stream instead of defaulting to 30s', async () => {
    await run(grpcReq(), { timeoutMs: 0 });
    expect(startCalls[0]!.timeoutMs).toBe(0);
  });

  it('feeds live hooks: onOpen gets controls, onMessage sees each message', async () => {
    const seen: unknown[] = [];
    let controls: StreamRunControls | undefined;
    await run(grpcReq(), {
      stream: {
        onOpen: (c) => {
          controls = c;
        },
        onMessage: (m) => seen.push(m),
      },
    });
    expect(controls).toBeDefined();
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('auto-sends the message(s) and half-closes a client stream without an onOpen hook', async () => {
    const stream = fakeStream([{ total: 3 }], okFinal, { waitForClose: true });
    nextStream = () => stream;
    const { res } = await run(
      grpcReq({ methodType: 'client-streaming', message: '[{"v":"{{tenant}}"},{"v":2}]' })
    );
    expect(stream.sent).toEqual([{ v: 'acme' }, { v: 2 }]);
    expect(stream.closed()).toBe(true);
    // A client stream has exactly one response — the body is that message.
    expect(JSON.parse(res.body)).toEqual({ total: 3 });
  });

  it('sends a single object message once for a bidi stream', async () => {
    const stream = fakeStream([{ echo: 1 }], okFinal, { waitForClose: true });
    nextStream = () => stream;
    await run(grpcReq({ methodType: 'bidirectional-streaming', message: '{"v":1}' }));
    expect(stream.sent).toEqual([{ v: 1 }]);
    expect(stream.closed()).toBe(true);
  });

  it('leaves sending to the caller when onOpen is provided (interactive)', async () => {
    const stream = fakeStream([], okFinal, { waitForClose: true });
    nextStream = () => stream;
    await run(grpcReq({ methodType: 'client-streaming' }), {
      stream: {
        onOpen: (c) => {
          void c.send({ manual: true });
          c.closeSend();
        },
      },
    });
    expect(stream.sent).toEqual([{ manual: true }]);
  });

  it('surfaces a non-OK final status to the response and the test script', async () => {
    nextStream = () =>
      fakeStream(
        [{ n: 1 }],
        { headers: {}, trailers: { 'grpc-message': 'boom' }, status: 13, statusMessage: 'boom' },
        { failWith: 'boom' }
      );
    const { res, scripts } = await run(
      grpcReq({ testScript: `rs.test('err', () => rs.expect(rs.response.code).to.equal(13));` })
    );
    expect(res.grpcStatus).toBe(13);
    expect(res.grpcStatusText).toBe('boom');
    expect(res.messages).toEqual(['{"n":1}']);
    expect(scripts?.test?.tests?.[0]?.passed).toBe(true);
  });

  it('carries decoded rich error details to the response and scripts (#883)', async () => {
    const statusDetails = [{ type: 'google.rpc.ErrorInfo', value: { reason: 'QUOTA' } }];
    nextStream = () =>
      fakeStream([], {
        headers: {},
        trailers: {},
        status: 8,
        statusMessage: 'quota',
        statusDetails,
      });
    const { res, scripts } = await run(
      grpcReq({
        testScript: `pm.test('details', () => pm.expect(pm.response.statusDetails[0].value.reason).to.equal('QUOTA'));`,
      })
    );
    expect(res.statusDetails).toEqual(statusDetails);
    expect(scripts?.test?.tests?.[0]?.passed).toBe(true);
  });

  it('bounds retained messages on a long stream and reports how many were dropped', async () => {
    const total = MAX_RETAINED_STREAM_MESSAGES + 25;
    const inbound = Array.from({ length: total }, (_, n) => ({ n }));
    nextStream = () => fakeStream(inbound, okFinal);
    const { res, scripts } = await run(
      grpcReq({
        testScript: `rs.test('count', () => rs.expect(rs.response.messages.count()).to.equal(${MAX_RETAINED_STREAM_MESSAGES}));`,
      })
    );
    expect(res.messages).toHaveLength(MAX_RETAINED_STREAM_MESSAGES);
    expect(res.messages?.[0]).toBe('{"n":25}');
    expect(res.droppedMessages).toBe(25);
    expect(scripts?.test?.tests?.[0]?.passed).toBe(true);
  });

  it('cancels the stream when the run is aborted', async () => {
    const stream = fakeStream([{ n: 1 }], okFinal, { waitForClose: true });
    nextStream = () => stream;
    const ctrl = new AbortController();
    const p = run(grpcReq({ methodType: 'bidirectional-streaming' }), {
      signal: ctrl.signal,
      stream: { onOpen: () => {} },
    });
    await vi.waitFor(() => expect(startCalls).toHaveLength(1));
    ctrl.abort();
    const { res } = await p;
    expect(stream.cancelled()).toBe(true);
    expect(res.grpcStatus).toBe(1);
  });

  it('rejects an invalid outbound message for auto-send', async () => {
    nextStream = () => fakeStream([], okFinal, { waitForClose: true });
    await expect(
      run(grpcReq({ methodType: 'client-streaming', message: '{not json' }))
    ).rejects.toThrow(/Invalid JSON/);
  });
});
