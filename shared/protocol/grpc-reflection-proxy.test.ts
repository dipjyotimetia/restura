// @vitest-environment node
/**
 * Behaviour of the Connect-streaming reflection client used by the Worker and
 * Node self-host (`/api/grpc/reflection`): envelope decoding, the v1 → v1alpha
 * fallback, upstream failure diagnostics, and the body-size cap on every body
 * shape a Fetcher can expose (#875, #933).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  decodeConnectStream,
  dropReservedReflectionMetadata,
  encodeConnectEnvelope,
  executeGrpcReflectionProxy,
  REFLECTION_SERVICE_V1,
  REFLECTION_SERVICE_V1_ALPHA,
} from './grpc-reflection-proxy';
import { MAX_RESPONSE_SIZE } from './http-proxy';
import type { Fetcher, FetcherRequest, FetcherResponse } from './types';

const OPTS = { allowLocalhost: false };
const SPEC = { url: 'https://grpc.example.com/', request: { listServices: '' } };
const CONNECT_JSON = { 'content-type': 'application/connect+json' };

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function stream(message: unknown = { listServicesResponse: { service: [] } }): Uint8Array {
  return concat(encodeConnectEnvelope(message), encodeConnectEnvelope({}, 0b10));
}

function response(overrides: Partial<FetcherResponse> = {}): FetcherResponse {
  return {
    status: 200,
    statusText: 'OK',
    headers: CONNECT_JSON,
    text: async () => '',
    body: new Response(stream() as Uint8Array<ArrayBuffer>).body as ReadableStream<Uint8Array>,
    contentLengthHeader: null,
    ...overrides,
  };
}

/** Answer each reflection version from its own factory, recording the calls. */
function versionedFetcher(
  byService: Record<string, () => FetcherResponse | Promise<FetcherResponse>>
): { fetcher: Fetcher; calls: FetcherRequest[] } {
  const calls: FetcherRequest[] = [];
  const fetcher: Fetcher = async (req) => {
    calls.push(req);
    const service = Object.keys(byService).find((s) => req.url.includes(`/${s}/`));
    if (!service) throw new Error(`unexpected url ${req.url}`);
    return byService[service]!();
  };
  return { fetcher, calls };
}

describe('decodeConnectStream', () => {
  it('returns the data messages that precede a clean end-stream', () => {
    const bytes = concat(
      encodeConnectEnvelope({ a: 1 }),
      encodeConnectEnvelope({ b: 2 }),
      stream()
    );
    expect(decodeConnectStream(bytes)).toEqual([
      { a: 1 },
      { b: 2 },
      { listServicesResponse: { service: [] } },
    ]);
  });

  it('accepts a zero-length end-stream envelope', () => {
    const endStream = new Uint8Array([0b10, 0, 0, 0, 0]);
    expect(decodeConnectStream(concat(encodeConnectEnvelope({ a: 1 }), endStream))).toEqual([
      { a: 1 },
    ]);
  });

  it('surfaces an RPC error carried by the end-stream envelope', () => {
    const bytes = encodeConnectEnvelope(
      { error: { code: 'unimplemented', message: 'no reflection' } },
      0b10
    );
    expect(() => decodeConnectStream(bytes)).toThrow('unimplemented: no reflection');
  });

  it('falls back to generic text when the end-stream error has no code or message', () => {
    expect(() => decodeConnectStream(encodeConnectEnvelope({ error: {} }, 0b10))).toThrow(
      'unknown: reflection RPC failed'
    );
  });

  it('rejects a compressed envelope we never negotiated', () => {
    expect(() => decodeConnectStream(encodeConnectEnvelope({ a: 1 }, 0b01))).toThrow(/compression/);
  });

  it('rejects truncated headers, truncated payloads and a missing end-stream', () => {
    expect(() => decodeConnectStream(new Uint8Array([0, 0, 0]))).toThrow(
      /truncated envelope header/
    );
    expect(() => decodeConnectStream(encodeConnectEnvelope({ a: 1 }).subarray(0, 8))).toThrow(
      /truncated envelope payload/
    );
    expect(() => decodeConnectStream(encodeConnectEnvelope({ a: 1 }))).toThrow(
      /missing end-stream/
    );
  });
});

describe('dropReservedReflectionMetadata', () => {
  it('drops transport-owned keys case-insensitively and tolerates no metadata', () => {
    expect(
      dropReservedReflectionMetadata({
        'Grpc-Timeout': '1S',
        'connect-content-encoding': 'gzip',
        authorization: 'Bearer t',
      })
    ).toEqual({ authorization: 'Bearer t' });
    expect(dropReservedReflectionMetadata(undefined)).toEqual({});
  });
});

describe('executeGrpcReflectionProxy', () => {
  it('speaks Connect streaming to the v1 service and tags the version', async () => {
    const { fetcher, calls } = versionedFetcher({ [REFLECTION_SERVICE_V1]: () => response() });
    const r = await executeGrpcReflectionProxy(SPEC, fetcher, OPTS);
    expect(r).toEqual({
      ok: true,
      response: { listServicesResponse: { service: [] }, reflectionVersion: 'v1' },
    });
    expect(calls[0]?.url).toBe(
      `https://grpc.example.com/${REFLECTION_SERVICE_V1}/ServerReflectionInfo`
    );
    const headers = new Headers(calls[0]?.headers);
    expect(headers.get('content-type')).toBe('application/connect+json');
    expect(headers.get('connect-timeout-ms')).toBe('30000');
  });

  it('falls back to v1alpha when v1 fails and reads a Headers instance', async () => {
    const { fetcher, calls } = versionedFetcher({
      [REFLECTION_SERVICE_V1]: () => response({ status: 404, statusText: 'Not Found' }),
      [REFLECTION_SERVICE_V1_ALPHA]: () =>
        response({ headers: new Headers({ 'Content-Type': 'application/connect+json' }) }),
    });
    const r = await executeGrpcReflectionProxy(SPEC, fetcher, OPTS);
    expect(r.ok && r.response.reflectionVersion).toBe('v1alpha');
    expect(calls).toHaveLength(2);
  });

  it('reads an arrayBuffer-only body (fetchers without a stream)', async () => {
    const bytes = stream({ fileDescriptorResponse: {} });
    const { fetcher } = versionedFetcher({
      [REFLECTION_SERVICE_V1]: () =>
        response({
          body: undefined,
          arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
        }),
    });
    const r = await executeGrpcReflectionProxy(SPEC, fetcher, OPTS);
    expect(r.ok && r.response.fileDescriptorResponse).toEqual({});
  });

  it('explains HTTP/2 and Connect-protocol refusals', async () => {
    const { fetcher } = versionedFetcher({
      [REFLECTION_SERVICE_V1]: () => response({ status: 505, statusText: '' }),
      [REFLECTION_SERVICE_V1_ALPHA]: () =>
        response({ status: 415, statusText: 'Unsupported Media Type' }),
    });
    const r = await executeGrpcReflectionProxy(SPEC, fetcher, OPTS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(500);
    expect(r.payload.error).toContain('v1 (HTTP 505 — the server requires HTTP/2');
    expect(r.payload.error).toContain(
      'v1alpha (HTTP 415 Unsupported Media Type — the server does not accept the Connect protocol'
    );
  });

  it('rejects a non-Connect content-type (array-valued or missing)', async () => {
    const { fetcher } = versionedFetcher({
      [REFLECTION_SERVICE_V1]: () => response({ headers: { 'Content-Type': ['text/html'] } }),
      [REFLECTION_SERVICE_V1_ALPHA]: () => response({ headers: {} }),
    });
    const r = await executeGrpcReflectionProxy(SPEC, fetcher, OPTS);
    expect(!r.ok && r.payload.error).toBe(
      'Reflection failed on v1 (Unexpected reflection content-type "text/html") and v1alpha (Unexpected reflection content-type "none")'
    );
  });

  it('fails when the stream carries no response message', async () => {
    const empty = encodeConnectEnvelope({}, 0b10);
    const { fetcher } = versionedFetcher({
      [REFLECTION_SERVICE_V1]: () =>
        response({ body: undefined, arrayBuffer: async () => empty.slice().buffer as ArrayBuffer }),
      [REFLECTION_SERVICE_V1_ALPHA]: () => response({ body: undefined }),
    });
    const r = await executeGrpcReflectionProxy(SPEC, fetcher, OPTS);
    expect(!r.ok && r.payload.error).toBe(
      'Reflection failed on v1 (Reflection stream ended without a response message) and v1alpha (Fetcher exposes no binary body for a Connect stream)'
    );
  });

  it('short-circuits to 413 on an oversized content-length without retrying', async () => {
    const cancel = vi.fn(async () => undefined);
    const { fetcher, calls } = versionedFetcher({
      [REFLECTION_SERVICE_V1]: () =>
        response({
          contentLengthHeader: String(MAX_RESPONSE_SIZE + 1),
          body: { cancel } as unknown as ReadableStream<Uint8Array>,
        }),
    });
    const r = await executeGrpcReflectionProxy(SPEC, fetcher, OPTS);
    expect(r).toMatchObject({
      ok: false,
      status: 413,
      payload: { grpcStatusText: 'RESOURCE_EXHAUSTED' },
    });
    expect(cancel).toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('returns 413 when the v1alpha arrayBuffer body crosses the cap', async () => {
    const { fetcher } = versionedFetcher({
      [REFLECTION_SERVICE_V1]: () => response({ status: 404 }),
      [REFLECTION_SERVICE_V1_ALPHA]: () =>
        response({
          body: undefined,
          arrayBuffer: async () => new ArrayBuffer(MAX_RESPONSE_SIZE + 1),
        }),
    });
    const r = await executeGrpcReflectionProxy(SPEC, fetcher, OPTS);
    expect(!r.ok && r.status).toBe(413);
  });

  it('reports a timeout when the upstream never answers', async () => {
    vi.useFakeTimers();
    try {
      const fetcher: Fetcher = (req) =>
        new Promise((_, reject) => {
          req.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      const pending = executeGrpcReflectionProxy({ ...SPEC, timeout: 50 }, fetcher, OPTS);
      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(50);
      const r = await pending;
      expect(!r.ok && r.payload.error).toBe(
        'Reflection failed on v1 (Reflection request timed out) and v1alpha (Reflection request timed out)'
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('stringifies non-Error failures from the fetcher', async () => {
    const fetcher: Fetcher = async () => {
      throw 'socket hang up';
    };
    const r = await executeGrpcReflectionProxy(SPEC, fetcher, OPTS);
    expect(!r.ok && r.payload.error).toBe(
      'Reflection failed on v1 (socket hang up) and v1alpha (socket hang up)'
    );
  });
});
