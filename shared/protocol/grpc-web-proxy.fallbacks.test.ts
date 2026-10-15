// @vitest-environment node
/**
 * gRPC-Web proxy (#914) behaviour on the less common upstream shapes: fetchers
 * without a streaming body, malformed or missing statuses, mid-stream
 * failures and cancellation while the body is being read.
 */
import { describe, expect, it } from 'vitest';
import { bytesToBase64, encodeGrpcWebFrame, GRPC_WEB_TRAILER_FLAG } from './grpc-web-framing';
import {
  collectGrpcWebEvents,
  executeGrpcWebProxy,
  type GrpcWebEvent,
  type GrpcWebSpec,
  grpcWebStatusFromHttp,
} from './grpc-web-proxy';
import type { Fetcher, FetcherResponse } from './types';

const enc = new TextEncoder();
const OPTS = { allowLocalhost: false };

function spec(overrides: Partial<GrpcWebSpec> = {}): GrpcWebSpec {
  return {
    url: 'https://grpc.example.com',
    service: 'echo.v1.EchoService',
    method: 'UnaryEcho',
    message: bytesToBase64(new Uint8Array([10, 2, 104, 105])),
    ...overrides,
  };
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const okBody = () =>
  concat(
    encodeGrpcWebFrame(new Uint8Array([8, 1])),
    encodeGrpcWebFrame(enc.encode('grpc-status: 0\r\n'), GRPC_WEB_TRAILER_FLAG)
  );

function respond(overrides: Partial<FetcherResponse>): Fetcher {
  return async () => ({
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/grpc-web+proto' },
    text: async () => '',
    contentLengthHeader: null,
    ...overrides,
  });
}

async function run(s: GrpcWebSpec, fetcher: Fetcher) {
  const result = executeGrpcWebProxy(s, fetcher, OPTS);
  if (!result.ok) throw new Error(`unexpected validation failure: ${result.payload.error}`);
  return collectGrpcWebEvents(result.events);
}

describe('executeGrpcWebProxy — body shapes', () => {
  it('reads an arrayBuffer-only response', async () => {
    const bytes = okBody();
    const out = await run(
      spec(),
      respond({ arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer })
    );
    expect(out.messages).toEqual([bytesToBase64(new Uint8Array([8, 1]))]);
    expect(out.end.grpcStatus).toBe(0);
  });

  it('falls back to text() for grpc-web-text responses', async () => {
    const out = await run(
      spec({ format: 'text' }),
      respond({
        headers: { 'content-type': 'application/grpc-web-text' },
        text: async () => bytesToBase64(okBody()),
      })
    );
    expect(out.messages).toHaveLength(1);
    expect(out.end.grpcStatus).toBe(0);
  });

  it('refuses a binary response from a fetcher that only exposes text()', async () => {
    const out = await run(spec(), respond({}));
    expect(out.end.grpcStatus).toBe(14);
    expect(out.end.grpcMessage).toMatch(/binary-capable fetcher/);
  });

  it('skips empty body chunks', async () => {
    const bytes = okBody();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(0));
        c.enqueue(bytes);
        c.close();
      },
    });
    const out = await run(spec(), respond({ body }));
    expect(out.end.grpcStatus).toBe(0);
    expect(out.end.size).toBe(bytes.length);
  });
});

describe('executeGrpcWebProxy — statuses and failures', () => {
  it('reports a malformed grpc-status as UNKNOWN', async () => {
    const out = await run(
      spec(),
      respond({ headers: { 'grpc-status': 'abc' }, body: new Response('').body ?? undefined })
    );
    expect(out.end.grpcStatus).toBe(2);
    expect(out.end.grpcMessage).toBe('invalid grpc-status "abc"');
  });

  it('reports a trailer frame without grpc-status as INTERNAL', async () => {
    const body = encodeGrpcWebFrame(enc.encode('x-trace: 1\r\n'), GRPC_WEB_TRAILER_FLAG);
    const out = await run(
      spec(),
      respond({ arrayBuffer: async () => body.slice().buffer as ArrayBuffer })
    );
    expect(out.end).toMatchObject({
      grpcStatus: 13,
      grpcMessage: 'gRPC-Web trailers missing grpc-status',
      trailers: { 'x-trace': '1' },
    });
  });

  it('names a response with no content type', async () => {
    const out = await run(spec(), respond({ headers: {} }));
    expect(out.end.grpcMessage).toMatch(/unsupported content type \(none\)/);
  });

  it('maps rate limiting to UNAVAILABLE', () => {
    expect(grpcWebStatusFromHttp(429)).toBe(14);
  });

  it('reports a non-Error fetch rejection generically', async () => {
    const out = await run(spec(), async () => {
      throw 'socket closed';
    });
    expect(out.end.grpcStatus).toBe(14);
    expect(out.end.grpcMessage).toBe('Proxy request failed: Proxy request failed');
  });

  it('maps a body read failure to UNAVAILABLE with its message', async () => {
    const failing = (reason: unknown) =>
      new ReadableStream<Uint8Array>({
        pull(c) {
          c.error(reason);
        },
      });
    const out = await run(spec(), respond({ body: failing(new Error('connection reset')) }));
    expect(out.end).toMatchObject({ grpcStatus: 14, grpcMessage: 'connection reset' });
    const raw = await run(spec(), respond({ body: failing('reset') }));
    expect(raw.end).toMatchObject({ grpcStatus: 14, grpcMessage: 'reset' });
  });

  it('ends with CANCELLED when cancelled while the body is streaming', async () => {
    let fail!: (reason: unknown) => void;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encodeGrpcWebFrame(new Uint8Array([1])));
        fail = (reason) => c.error(reason);
      },
    });
    const result = executeGrpcWebProxy(spec(), respond({ body }), OPTS);
    if (!result.ok) throw new Error('validation failed');
    const events: GrpcWebEvent[] = [];
    for await (const ev of result.events) {
      events.push(ev);
      if (ev.type === 'message') {
        result.cancel();
        fail(new Error('stream torn down'));
      }
    }
    expect(events.at(-1)).toMatchObject({ type: 'end', grpcStatus: 1 });
  });
});

describe('collectGrpcWebEvents', () => {
  it('reports INTERNAL when the event stream ends without a status', async () => {
    async function* noEnd(): AsyncGenerator<GrpcWebEvent> {
      yield { type: 'headers', headers: { a: '1' } };
      yield { type: 'message', data: 'AQ==' };
    }
    const out = await collectGrpcWebEvents(noEnd());
    expect(out.headers).toEqual({ a: '1' });
    expect(out.messages).toEqual(['AQ==']);
    expect(out.end).toMatchObject({
      grpcStatus: 13,
      grpcMessage: 'gRPC-Web stream ended without a status',
    });
  });
});
