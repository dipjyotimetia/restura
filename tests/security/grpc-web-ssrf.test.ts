// @vitest-environment node
/**
 * Security regressions for the gRPC-Web transport (#914): the new outbound
 * path must inherit the shared SSRF guard and header policy, never follow
 * redirects, and run the Node DNS guard on the self-host backend.
 */
import { bytesToBase64, encodeGrpcWebFrame } from '@shared/protocol/grpc-web-framing';
import { collectGrpcWebEvents, executeGrpcWebProxy } from '@shared/protocol/grpc-web-proxy';
import type { Fetcher, FetcherRequest } from '@shared/protocol/types';
import { describe, expect, it, vi } from 'vitest';

const base = {
  service: 'echo.v1.EchoService',
  method: 'UnaryEcho',
  message: bytesToBase64(new Uint8Array([1])),
};

const okBody = encodeGrpcWebFrame(new TextEncoder().encode('grpc-status: 0\r\n'), 0x80);

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

// The Worker fetcher's redirect: 'manual' + Node DNS-guard checks live in
// worker/handlers/__tests__/grpc-web.test.ts (the renderer tsconfig that
// covers tests/ must not pull in worker/ sources).
