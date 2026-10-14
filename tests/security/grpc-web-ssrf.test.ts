// @vitest-environment node
/**
 * Security regressions for the gRPC-Web transport (#914): the new outbound
 * path must inherit the shared SSRF guard and header policy, never follow
 * redirects, and run the Node DNS guard on the self-host backend.
 */
import { bytesToBase64, encodeGrpcWebFrame } from '@shared/protocol/grpc-web-framing';
import { collectGrpcWebEvents, executeGrpcWebProxy } from '@shared/protocol/grpc-web-proxy';
import type { Fetcher, FetcherRequest } from '@shared/protocol/types';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGrpcWebHandler } from '../../worker/handlers/grpc-web';

const base = {
  service: 'echo.v1.EchoService',
  method: 'UnaryEcho',
  message: bytesToBase64(new Uint8Array([1])),
};

const okBody = encodeGrpcWebFrame(new TextEncoder().encode('grpc-status: 0\r\n'), 0x80);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('gRPC-Web SSRF guard', () => {
  const blocked = [
    'http://127.0.0.1:8080',
    'http://localhost',
    'http://[::1]',
    'http://10.1.2.3',
    'http://172.16.0.1',
    'http://192.168.1.1',
    'http://100.64.0.1',
    'http://169.254.169.254',
    'http://metadata.google.internal',
    'http://[::ffff:10.0.0.1]',
    'http://[fd00::1]',
    'file:///etc/passwd',
  ];

  it.each(blocked)('refuses %s before any network call', (url) => {
    const fetcher = vi.fn<Fetcher>();
    const result = executeGrpcWebProxy({ ...base, url }, fetcher, { allowLocalhost: false });
    expect(result.ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('private ranges require the explicit self-host opt-in', () => {
    const fetcher = vi.fn<Fetcher>();
    expect(
      executeGrpcWebProxy({ ...base, url: 'http://10.1.2.3' }, fetcher, {
        allowLocalhost: false,
        allowPrivateIPs: true,
      }).ok
    ).toBe(true);
    // Cloud metadata stays blocked even with the private-IP opt-in.
    expect(
      executeGrpcWebProxy({ ...base, url: 'http://169.254.169.254' }, fetcher, {
        allowLocalhost: false,
        allowPrivateIPs: true,
      }).ok
    ).toBe(false);
  });
});

describe('gRPC-Web header policy', () => {
  it('strips hop-by-hop headers and protects the protocol headers', async () => {
    let seen: FetcherRequest | undefined;
    const fetcher: Fetcher = async (req) => {
      seen = req;
      return {
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/grpc-web+proto' }),
        text: async () => '',
        arrayBuffer: async () => okBody.slice().buffer,
        contentLengthHeader: null,
      };
    };
    const result = executeGrpcWebProxy(
      {
        ...base,
        url: 'https://grpc.example.com',
        metadata: {
          Host: 'internal.example',
          Connection: 'upgrade',
          'Proxy-Authorization': 'Basic x',
          'Transfer-Encoding': 'chunked',
          'Content-Type': 'application/json',
          'X-Grpc-Web': '0',
          'Grpc-Timeout': '99H',
        },
      },
      fetcher,
      { allowLocalhost: false }
    );
    if (!result.ok) throw new Error('unexpected rejection');
    await collectGrpcWebEvents(result.events);
    const h = seen?.headers as Record<string, string>;
    const keys = Object.keys(h).map((k) => k.toLowerCase());
    for (const denied of ['host', 'connection', 'proxy-authorization', 'transfer-encoding']) {
      expect(keys).not.toContain(denied);
    }
    expect(h['content-type']).toBe('application/grpc-web+proto');
    expect(h['x-grpc-web']).toBe('1');
    expect(h['grpc-timeout']).toBe('30000m');
  });
});

describe('/api/grpc-web Worker fetcher', () => {
  it('never follows redirects (a 3xx surfaces as an error status)', async () => {
    const fetchMock = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/' } })
    );
    vi.stubGlobal('fetch', fetchMock);
    const app = new Hono();
    app.post('/api/grpc-web', createGrpcWebHandler());
    const res = await app.request(
      '/api/grpc-web',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...base, url: 'https://grpc.example.com' }),
      },
      {}
    );
    const lines = (await res.text()).trim().split('\n');
    const end = JSON.parse(lines.at(-1) as string);
    expect(end.grpcStatus).not.toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1 as never] as RequestInit;
    expect(init.redirect).toBe('manual');
  });

  it('runs the Node hostname (DNS) guard before connecting', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const guard = vi.fn(async () => {
      throw new Error('resolves to a private address');
    });
    const app = new Hono();
    app.post('/api/grpc-web', createGrpcWebHandler(guard));
    const res = await app.request(
      '/api/grpc-web',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...base, url: 'https://rebind.example.com' }),
      },
      {}
    );
    const end = JSON.parse((await res.text()).trim().split('\n').at(-1) as string);
    expect(guard).toHaveBeenCalledWith('rebind.example.com', expect.any(Object));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(end.grpcStatus).toBe(14);
  });
});
