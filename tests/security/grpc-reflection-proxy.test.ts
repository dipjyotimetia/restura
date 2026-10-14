// @vitest-environment node
/**
 * Security regressions for the web/self-host reflection path
 * (shared/protocol/grpc-reflection-proxy.ts): SSRF guard before any fetch,
 * metadata header policy (#887), and the streaming body cap (#933).
 */
import {
  encodeConnectEnvelope,
  executeGrpcReflectionProxy,
} from '@shared/protocol/grpc-reflection-proxy';
import { GrpcReflectionRequestBodySchema } from '@shared/protocol/grpc-schema';
import type { Fetcher, FetcherRequest } from '@shared/protocol/types';
import { describe, expect, it, vi } from 'vitest';

const OPTS = { allowLocalhost: false };

function okStream(): ReadableStream<Uint8Array> {
  const a = encodeConnectEnvelope({ listServicesResponse: { service: [] } });
  const b = encodeConnectEnvelope({}, 0b10);
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return new Response(out).body as ReadableStream<Uint8Array>;
}

function capturingFetcher(): { fetcher: Fetcher; calls: FetcherRequest[] } {
  const calls: FetcherRequest[] = [];
  const fetcher: Fetcher = async (req) => {
    calls.push(req);
    return {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/connect+json' },
      text: async () => '',
      body: okStream(),
      contentLengthHeader: null,
    };
  };
  return { fetcher, calls };
}

describe('gRPC reflection proxy security', () => {
  it.each([
    'http://127.0.0.1:50051',
    'http://10.0.0.5',
    'http://169.254.169.254',
    'http://[::ffff:127.0.0.1]',
  ])('blocks %s before any upstream fetch', async (url) => {
    const fetcher = vi.fn();
    const r = await executeGrpcReflectionProxy(
      { url, request: { listServices: '' } },
      fetcher,
      OPTS
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('strips hop-by-hop / proxy credentials from metadata', async () => {
    const { fetcher, calls } = capturingFetcher();
    await executeGrpcReflectionProxy(
      {
        url: 'https://grpc.example.com',
        request: { listServices: '' },
        metadata: { 'proxy-authorization': 'Basic x', host: 'evil.example', 'x-ok': '1' },
      },
      fetcher,
      OPTS
    );
    const headers = new Headers(calls[0]?.headers);
    expect(headers.get('proxy-authorization')).toBeNull();
    expect(headers.get('host')).toBeNull();
    expect(headers.get('x-ok')).toBe('1');
  });

  it('rejects CR/LF header injection at the schema boundary', () => {
    const parsed = GrpcReflectionRequestBodySchema.safeParse({
      url: 'https://grpc.example.com',
      request: { listServices: '' },
      metadata: { 'x-a': 'v\r\nx-injected: 1' },
    });
    expect(parsed.success).toBe(false);
  });

  it('cuts off an endless chunked body at the cap (413)', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024);
    const fetcher: Fetcher = async () => ({
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/connect+json' },
      text: async () => '',
      body: new ReadableStream<Uint8Array>({
        pull(c) {
          pulled++;
          c.enqueue(chunk);
        },
      }),
      contentLengthHeader: null,
    });
    const r = await executeGrpcReflectionProxy(
      { url: 'https://grpc.example.com', request: { listServices: '' } },
      fetcher,
      OPTS
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(413);
    expect(pulled).toBeLessThan(170);
  });
});
