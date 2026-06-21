import { describe, it, expect, vi } from 'vitest';
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
