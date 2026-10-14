// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { type Equals, expectTypeEqual } from '../../tests/helpers/typeEquality';
import {
  bytesToBase64,
  encodeGrpcWebFrame,
  GRPC_WEB_COMPRESSED_FLAG,
  GRPC_WEB_TRAILER_FLAG,
} from './grpc-web-framing';
import {
  collectGrpcWebEvents,
  type ExecuteGrpcWebOptions,
  executeGrpcWebProxy,
  type GrpcWebSpec,
  grpcWebStatusFromHttp,
  MAX_GRPC_WEB_REQUEST_BYTES,
} from './grpc-web-proxy';
import { type GrpcWebProxyRequestBody, GrpcWebProxyRequestBodySchema } from './grpc-web-schema';
import type { Fetcher, FetcherRequest } from './types';

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

function trailerFrame(lines: string): Uint8Array {
  return encodeGrpcWebFrame(enc.encode(lines), GRPC_WEB_TRAILER_FLAG);
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

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

function fetcherReturning(
  body: Uint8Array | string,
  init: { status?: number; headers?: Record<string, string> } = {},
  capture?: (req: FetcherRequest) => void
): Fetcher {
  return async (req) => {
    capture?.(req);
    const bytes = typeof body === 'string' ? enc.encode(body) : body;
    return {
      status: init.status ?? 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/grpc-web+proto', ...init.headers }),
      text: async () => new TextDecoder().decode(bytes),
      contentLengthHeader: null,
      body: streamOf([bytes.subarray(0, 3), bytes.subarray(3)]),
    };
  };
}

async function run(s: GrpcWebSpec, fetcher: Fetcher, opts: ExecuteGrpcWebOptions = OPTS) {
  const result = executeGrpcWebProxy(s, fetcher, opts);
  if (!result.ok) throw new Error(`unexpected validation failure: ${result.payload.error}`);
  return collectGrpcWebEvents(result.events);
}

describe('GrpcWebSpec / GrpcWebProxyRequestBodySchema parity', () => {
  it('types are identical', () => {
    expectTypeEqual<Equals<GrpcWebSpec, GrpcWebProxyRequestBody>>();
  });

  it('a representative spec parses', () => {
    expect(GrpcWebProxyRequestBodySchema.safeParse(spec({ format: 'text' })).success).toBe(true);
    expect(GrpcWebProxyRequestBodySchema.safeParse({ url: 'x' }).success).toBe(false);
  });
});

describe('executeGrpcWebProxy — request shaping', () => {
  it('frames the message and sets gRPC-Web headers that metadata cannot override', async () => {
    let seen: FetcherRequest | undefined;
    const body = concat(trailerFrame('grpc-status: 0\r\n'));
    await run(
      spec({
        metadata: { 'Content-Type': 'text/plain', authorization: 'Bearer t', host: 'evil' },
        timeout: 1500,
      }),
      fetcherReturning(body, {}, (r) => {
        seen = r;
      })
    );
    expect(seen?.url).toBe('https://grpc.example.com/echo.v1.EchoService/UnaryEcho');
    expect(seen?.method).toBe('POST');
    const h = seen?.headers as Record<string, string>;
    expect(h['content-type']).toBe('application/grpc-web+proto');
    expect(h['x-grpc-web']).toBe('1');
    expect(h['grpc-timeout']).toBe('1500m');
    expect(h.authorization).toBe('Bearer t');
    // Hop-by-hop / host headers are stripped by the shared header policy.
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain('host');
    expect(Array.from(seen?.body as Uint8Array)).toEqual([0, 0, 0, 0, 4, 10, 2, 104, 105]);
  });

  it('base64-encodes the framed body in text mode', async () => {
    let seen: FetcherRequest | undefined;
    await run(
      spec({ format: 'text' }),
      fetcherReturning(
        bytesToBase64(trailerFrame('grpc-status: 0\r\n')),
        { headers: { 'content-type': 'application/grpc-web-text' } },
        (r) => {
          seen = r;
        }
      )
    );
    const h = seen?.headers as Record<string, string>;
    expect(h['content-type']).toBe('application/grpc-web-text');
    expect(seen?.body).toBe(bytesToBase64(encodeGrpcWebFrame(new Uint8Array([10, 2, 104, 105]))));
  });
});

describe('executeGrpcWebProxy — validation', () => {
  const never: Fetcher = vi.fn(async () => {
    throw new Error('must not be called');
  });

  it.each([
    ['private IP', { url: 'http://10.0.0.1:8080' }],
    ['localhost', { url: 'http://localhost:8080' }],
    ['cloud metadata', { url: 'http://169.254.169.254' }],
    ['bad service', { service: 'bad/service' }],
    ['bad method', { method: '../x' }],
    ['non-base64 message', { message: 'not base64!' }],
  ])('rejects %s before any network call', (_label, overrides) => {
    const result = executeGrpcWebProxy(spec(overrides), never, OPTS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
    expect(never).not.toHaveBeenCalled();
  });

  it('rejects an oversized request message', () => {
    const big = bytesToBase64(new Uint8Array(MAX_GRPC_WEB_REQUEST_BYTES + 1));
    const result = executeGrpcWebProxy(spec({ message: big }), never, OPTS);
    expect(result.ok).toBe(false);
  });
});

describe('executeGrpcWebProxy — response parsing', () => {
  it('relays messages, headers and trailers (binary)', async () => {
    const body = concat(
      encodeGrpcWebFrame(new Uint8Array([1, 2])),
      encodeGrpcWebFrame(new Uint8Array([3])),
      trailerFrame('grpc-status: 0\r\nx-trailer: yes\r\n')
    );
    const out = await run(spec(), fetcherReturning(body, { headers: { 'x-h': 'v' } }));
    expect(out.messages).toEqual([bytesToBase64(new Uint8Array([1, 2])), 'Aw==']);
    expect(out.headers['x-h']).toBe('v');
    expect(out.end.grpcStatus).toBe(0);
    expect(out.end.grpcStatusText).toBe('OK');
    expect(out.end.trailers['x-trailer']).toBe('yes');
    expect(out.end.size).toBe(body.length);
  });

  it('decodes grpc-web-text responses', async () => {
    const text =
      bytesToBase64(encodeGrpcWebFrame(new Uint8Array([7]))) +
      bytesToBase64(trailerFrame('grpc-status: 0\r\n'));
    const out = await run(
      spec({ format: 'text' }),
      fetcherReturning(text, { headers: { 'content-type': 'application/grpc-web-text+proto' } })
    );
    expect(out.messages).toEqual(['Bw==']);
    expect(out.end.grpcStatus).toBe(0);
  });

  it('reads a non-OK status and percent-decoded message from the trailer frame', async () => {
    const out = await run(
      spec(),
      fetcherReturning(trailerFrame('grpc-status: 5\r\ngrpc-message: no%20such%20thing\r\n'))
    );
    expect(out.end.grpcStatus).toBe(5);
    expect(out.end.grpcStatusText).toBe('NOT_FOUND');
    expect(out.end.grpcMessage).toBe('no such thing');
  });

  it('handles trailers-only responses (status in HTTP headers)', async () => {
    const out = await run(
      spec(),
      fetcherReturning(new Uint8Array(0), {
        headers: { 'grpc-status': '16', 'grpc-message': 'denied' },
      })
    );
    expect(out.end.grpcStatus).toBe(16);
    expect(out.end.grpcMessage).toBe('denied');
    expect(out.headers['grpc-status']).toBeUndefined();
    expect(out.end.trailers['grpc-status']).toBe('16');
  });

  it('maps a non-200 HTTP status without grpc-status', async () => {
    const out = await run(spec(), fetcherReturning('nope', { status: 404 }));
    expect(out.end.grpcStatus).toBe(12);
    expect(out.end.grpcMessage).toBe('HTTP 404');
  });

  it('flags a non gRPC-Web content type', async () => {
    const out = await run(
      spec(),
      fetcherReturning('{}', { headers: { 'content-type': 'application/json' } })
    );
    expect(out.end.grpcStatus).toBe(2);
    expect(out.end.grpcMessage).toMatch(/unsupported content type application\/json/);
  });

  it('reports a body that ends without a trailer frame', async () => {
    const out = await run(spec(), fetcherReturning(encodeGrpcWebFrame(new Uint8Array([1]))));
    expect(out.messages).toHaveLength(1);
    expect(out.end.grpcStatus).toBe(13);
  });

  it('rejects compressed frames', async () => {
    const out = await run(
      spec(),
      fetcherReturning(encodeGrpcWebFrame(new Uint8Array([1]), GRPC_WEB_COMPRESSED_FLAG))
    );
    expect(out.end.grpcStatus).toBe(13);
  });

  it('caps the response size (streamed bytes)', async () => {
    const body = concat(encodeGrpcWebFrame(new Uint8Array(64)), trailerFrame('grpc-status: 0\r\n'));
    const out = await run(spec(), fetcherReturning(body), { ...OPTS, maxResponseBytes: 32 });
    expect(out.end.grpcStatus).toBe(8);
    expect(out.end.grpcMessage).toMatch(/too large/);
  });

  it('caps the response size (content-length)', async () => {
    const fetcher: Fetcher = async () => ({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/grpc-web+proto' }),
      text: async () => '',
      contentLengthHeader: String(1024),
      body: streamOf([]),
    });
    const out = await run(spec(), fetcher, { ...OPTS, maxResponseBytes: 100 });
    expect(out.end.grpcStatus).toBe(8);
  });

  it('maps a network failure to UNAVAILABLE', async () => {
    const out = await run(spec(), async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(out.end.grpcStatus).toBe(14);
    expect(out.end.grpcMessage).toMatch(/ECONNREFUSED/);
  });

  it('maps the deadline to DEADLINE_EXCEEDED', async () => {
    const hang: Fetcher = (req) =>
      new Promise((_, reject) => {
        req.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        );
      });
    const out = await run(spec({ timeout: 20 }), hang);
    expect(out.end.grpcStatus).toBe(4);
  });

  it('cancel() ends the stream with CANCELLED', async () => {
    const hang: Fetcher = (req) =>
      new Promise((_, reject) => {
        req.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const result = executeGrpcWebProxy(spec(), hang, OPTS);
    if (!result.ok) throw new Error('validation failed');
    const pending = collectGrpcWebEvents(result.events);
    await new Promise((r) => setTimeout(r, 5));
    result.cancel();
    expect((await pending).end.grpcStatus).toBe(1);
  });
});

describe('grpcWebStatusFromHttp', () => {
  it('follows the gRPC HTTP-status mapping', () => {
    expect(grpcWebStatusFromHttp(400)).toBe(13);
    expect(grpcWebStatusFromHttp(401)).toBe(16);
    expect(grpcWebStatusFromHttp(403)).toBe(7);
    expect(grpcWebStatusFromHttp(404)).toBe(12);
    expect(grpcWebStatusFromHttp(503)).toBe(14);
    expect(grpcWebStatusFromHttp(418)).toBe(2);
  });
});
