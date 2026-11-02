// @vitest-environment node
/**
 * Worker/Node upstream routes must never follow an upstream redirect: URL
 * validation only covers the first hop, so a 3xx to an internal address would
 * otherwise be fetched and its body returned to the caller.
 */
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGrpcHandler } from '../grpc';
import { createGrpcReflectionHandler } from '../grpc-reflection';
import { createGrpcWebHandler } from '../grpc-web';
import { createMcpHandler } from '../mcp';
import { createMcpTerminateHandler } from '../mcp-terminate';

const LEAK = 'INTERNAL-SECRET-BODY';
const U = 'https://upstream.example.com/svc';

const app = new Hono();
app.post('/api/grpc', createGrpcHandler());
app.post('/api/grpc/reflection', createGrpcReflectionHandler());
app.post('/api/grpc-web', createGrpcWebHandler());
app.post('/api/mcp', createMcpHandler());
app.post('/api/mcp/terminate', createMcpTerminateHandler());

const routes: Array<[string, Record<string, unknown>]> = [
  ['/api/grpc', { url: U, service: 'a.B', method: 'C', message: {} }],
  ['/api/grpc/reflection', { url: U, request: { listServices: '' } }],
  ['/api/grpc-web', { url: U, service: 'a.B', method: 'C', message: 'AA==' }],
  ['/api/mcp', { url: U, transport: 'streamable-http', jsonRpc: { id: 1, method: 'ping' } }],
  ['/api/mcp/terminate', { url: U, transport: 'streamable-http', sessionId: 's1' }],
];

afterEach(() => vi.unstubAllGlobals());

describe('upstream redirects are not followed', () => {
  it.each(routes)('%s', async (path, body) => {
    // Mimic real fetch: a manual-redirect call sees the 302; a following call
    // would reach the "internal" target and get LEAK.
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.redirect === 'manual') {
        return new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/x' } });
      }
      return new Response(LEAK, { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.request(
      path,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      {}
    );
    const text = await res.text();

    // Reflection may retry v1alpha against the same validated URL; every
    // other route makes exactly one call. Never a call to the Location target.
    if (path === '/api/grpc/reflection') expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(2);
    else expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const [url, init] of fetchMock.mock.calls) {
      expect((init as RequestInit | undefined)?.redirect).toBe('manual');
      expect(String(url)).not.toContain('10.0.0.5');
    }
    if (path === '/api/grpc-web') {
      // Streams NDJSON: failures are reported in-band on the terminal event.
      const end = JSON.parse(text.trim().split('\n').at(-1) as string);
      expect(end.grpcStatus).not.toBe(0);
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    expect(text).not.toContain(LEAK);
  });
});
