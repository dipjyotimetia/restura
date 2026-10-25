import { describe, expect, it, vi } from 'vitest';
import { executeGrpcProxy } from './grpc-proxy';
import { GrpcStatusCode } from './grpc-status';
import { flattenHeaders as asRecord } from './header-utils';
import type { Fetcher } from './types';

function makeFetcher(body: string, status = 200, headers: Record<string, string> = {}): Fetcher {
  return vi.fn(async () => ({
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    headers,
    text: async () => body,
    contentLengthHeader: String(body.length),
  }));
}

describe('executeGrpcProxy', () => {
  it('rejects invalid service name', async () => {
    const r = await executeGrpcProxy(
      { url: 'https://example.com', service: '!!bad', method: 'Foo', timeout: 1000 },
      makeFetcher('{}'),
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(false);
  });

  it('rejects invalid method name', async () => {
    const r = await executeGrpcProxy(
      { url: 'https://example.com', service: 'svc.Foo', method: 'bad-name', timeout: 1000 },
      makeFetcher('{}'),
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(false);
  });

  it('rejects URL pointing to private IP', async () => {
    const r = await executeGrpcProxy(
      { url: 'http://10.0.0.1', service: 'svc.Foo', method: 'Bar', timeout: 1000 },
      makeFetcher('{}'),
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(false);
  });

  it('builds Connect URL and returns OK on 200', async () => {
    const fetcher = vi.fn(makeFetcher('{"x":1}', 200, { 'content-type': 'application/json' }));
    const r = await executeGrpcProxy(
      {
        url: 'https://example.com',
        service: 'svc.Foo',
        method: 'Bar',
        message: { a: 1 },
        timeout: 1000,
      },
      fetcher,
      { allowLocalhost: false }
    );
    expect(fetcher.mock.calls[0]?.[0]?.url).toBe('https://example.com/svc.Foo/Bar');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.response.grpcStatus).toBe(GrpcStatusCode.OK);
      expect(r.response.data).toEqual({ x: 1 });
    }
  });

  it('strips trailing slash from base URL when building Connect URL', async () => {
    const fetcher = vi.fn(makeFetcher('{}'));
    await executeGrpcProxy(
      { url: 'https://example.com/', service: 'svc.Foo', method: 'Bar', timeout: 1000 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(fetcher.mock.calls[0]?.[0]?.url).toBe('https://example.com/svc.Foo/Bar');
  });

  it('maps Connect error codes via parseConnectError', async () => {
    const fetcher = makeFetcher(JSON.stringify({ code: 'not_found', message: 'gone' }), 404, {
      'content-type': 'application/json',
    });
    const r = await executeGrpcProxy(
      { url: 'https://example.com', service: 'svc.Foo', method: 'Bar', timeout: 1000 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.response.grpcStatus).toBe(GrpcStatusCode.NOT_FOUND);
      expect((r.response.data as { error: string }).error).toBe('gone');
    }
  });

  it('decodes rich error details from the Connect error JSON (#883)', async () => {
    // google.rpc.BadRequest { field_violations: [{ field: "a", description: "b" }] }
    const badRequest = 'CgYKAWESAWI';
    const fetcher = makeFetcher(
      JSON.stringify({
        code: 'invalid_argument',
        message: 'bad',
        details: [
          { type: 'google.rpc.BadRequest', value: badRequest, debug: { x: 1 } },
          { type: 'acme.v1.Custom', value: 'AQI' },
        ],
      }),
      400
    );
    const r = await executeGrpcProxy(
      { url: 'https://example.com', service: 'svc.Foo', method: 'Bar', timeout: 1000 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok && r.response.statusDetails).toEqual([
      {
        type: 'google.rpc.BadRequest',
        value: { fieldViolations: [{ field: 'a', description: 'b' }] },
        debug: { x: 1 },
      },
      { type: 'acme.v1.Custom', raw: 'AQI=' },
    ]);
  });

  it('omits statusDetails when the error carries none', async () => {
    const fetcher = makeFetcher(JSON.stringify({ code: 'internal', message: 'x' }), 500);
    const r = await executeGrpcProxy(
      { url: 'https://example.com', service: 'svc.Foo', method: 'Bar', timeout: 1000 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok && 'statusDetails' in r.response).toBe(false);
  });

  it('separates trailer-prefixed headers into trailers map', async () => {
    const fetcher = makeFetcher('{}', 200, {
      'content-type': 'application/json',
      'trailer-grpc-status': '0',
      'trailer-x-extra': 'v',
    });
    const r = await executeGrpcProxy(
      { url: 'https://example.com', service: 'svc.Foo', method: 'Bar', timeout: 1000 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.response.trailers['grpc-status']).toBe('0');
      expect(r.response.trailers['x-extra']).toBe('v');
      expect(r.response.headers['trailer-grpc-status']).toBeUndefined();
    }
  });

  it('sends Connect protocol headers', async () => {
    const fetcher = vi.fn(makeFetcher('{}'));
    await executeGrpcProxy(
      { url: 'https://example.com', service: 'svc.Foo', method: 'Bar', timeout: 1000 },
      fetcher,
      { allowLocalhost: false }
    );
    const headers = asRecord(fetcher.mock.calls[0]?.[0]?.headers);
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Connect-Protocol-Version']).toBe('1');
  });

  it('forwards user metadata as headers (sanitised)', async () => {
    const fetcher = vi.fn(makeFetcher('{}'));
    await executeGrpcProxy(
      {
        url: 'https://example.com',
        service: 'svc.Foo',
        method: 'Bar',
        metadata: { 'X-User': 'alice', Host: 'attacker.com' },
        timeout: 1000,
      },
      fetcher,
      { allowLocalhost: false }
    );
    const headers = asRecord(fetcher.mock.calls[0]?.[0]?.headers);
    expect(headers['X-User']).toBe('alice');
    expect(headers.Host).toBeUndefined();
  });

  it('returns DEADLINE_EXCEEDED on timeout', async () => {
    const fetcher: Fetcher = (req) =>
      new Promise((_, reject) => {
        req.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          reject(e);
        });
      });
    const r = await executeGrpcProxy(
      { url: 'https://example.com', service: 'svc.Foo', method: 'Bar', timeout: 50 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(504);
      const payload = r.payload as { grpcStatus: number };
      expect(payload.grpcStatus).toBe(GrpcStatusCode.DEADLINE_EXCEEDED);
    }
  });

  it('returns UNAVAILABLE on fetcher error', async () => {
    const fetcher: Fetcher = async () => {
      throw new Error('connection refused');
    };
    const r = await executeGrpcProxy(
      { url: 'https://example.com', service: 'svc.Foo', method: 'Bar', timeout: 1000 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(502);
      const payload = r.payload as { grpcStatus: number };
      expect(payload.grpcStatus).toBe(GrpcStatusCode.UNAVAILABLE);
    }
  });
});

/**
 * A chunked (no content-length) body that would grow without bound. `pulled`
 * counts chunks handed out so tests can prove the read stops at the cap rather
 * than draining the upstream; `cancelled` flips when the reader gives up.
 */
function endlessChunkedBody(chunkBytes = 64 * 1024) {
  const state = { pulled: 0, cancelled: false };
  const chunk = new Uint8Array(chunkBytes).fill(0x61);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulled++;
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

describe('executeGrpcProxy bounded body read (#933)', () => {
  it('aborts a chunked oversize body at the cap with RESOURCE_EXHAUSTED / 413', async () => {
    const { stream, state } = endlessChunkedBody();
    const text = vi.fn(async () => 'should not be buffered');
    const fetcher: Fetcher = async () => ({
      status: 200,
      statusText: 'OK',
      headers: {},
      text,
      body: stream,
      contentLengthHeader: null,
    });
    const r = await executeGrpcProxy(
      { url: 'https://example.com', service: 'svc.Foo', method: 'Bar', timeout: 5000 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(413);
      expect((r.payload as { grpcStatus: number }).grpcStatus).toBe(
        GrpcStatusCode.RESOURCE_EXHAUSTED
      );
    }
    expect(text).not.toHaveBeenCalled();
    expect(state.cancelled).toBe(true);
    // 10MB cap / 64KB chunks ≈ 161 pulls (+ the stream's high-water prefetch).
    expect(state.pulled).toBeLessThan(170);
  });

  it('reads a streamed body under the cap as JSON', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ ok: 'streamed' }));
    const fetcher: Fetcher = async () => ({
      status: 200,
      statusText: 'OK',
      headers: {},
      text: async () => {
        throw new Error('text() must not be used when a stream is available');
      },
      body: new Response(bytes).body,
      contentLengthHeader: null,
    });
    const r = await executeGrpcProxy(
      { url: 'https://example.com', service: 'svc.Foo', method: 'Bar', timeout: 5000 },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.response.data).toEqual({ ok: 'streamed' });
      expect(r.response.size).toBe(bytes.byteLength);
    }
  });
});

describe('executeGrpcProxy timeout handling', () => {
  it.each([0, -5, Number.NaN])('does not abort immediately for timeout %s', async (timeout) => {
    let aborted: boolean | undefined;
    const fetcher: Fetcher = vi.fn(async (req) => {
      // Let a 0ms abort timer fire before sampling the signal.
      await new Promise((resolve) => setTimeout(resolve, 10));
      aborted = req.signal?.aborted;
      return {
        status: 200,
        statusText: 'OK',
        headers: {},
        text: async () => '{}',
        contentLengthHeader: '2',
      };
    });
    const r = await executeGrpcProxy(
      { url: 'https://example.com', service: 'svc.Foo', method: 'Bar', timeout },
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(true);
    expect(aborted).toBe(false);
  });
});
