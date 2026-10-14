// @vitest-environment node
/**
 * Security regressions for the Worker reflection transport (#887): redirects
 * are never followed and the Node hostname guard gates every upstream fetch.
 */
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createGrpcReflectionHandler } from '../grpc-reflection';

describe('gRPC reflection Worker handler transport', () => {
  function post(fetchImpl: (i: string, init: RequestInit) => Promise<Response>, guard?: never) {
    const app = new Hono();
    app.post('/r', createGrpcReflectionHandler(guard, fetchImpl));
    return app.request(
      '/r',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://grpc.example.com', request: { listServices: '' } }),
      },
      {}
    );
  }

  it('does not follow a 302 to the metadata endpoint', async () => {
    const fetchImpl = vi.fn(
      async (_i: string, init: RequestInit) =>
        new Response(null, {
          status: init.redirect === 'manual' ? 302 : 200,
          headers: { location: 'http://169.254.169.254/' },
        })
    );
    const res = await post(fetchImpl);
    expect(res.status).toBe(500);
    expect(fetchImpl.mock.calls.every(([, init]) => init.redirect === 'manual')).toBe(true);
    expect(((await res.json()) as { error: string }).error).toMatch(/HTTP 302/);
    for (const [url] of fetchImpl.mock.calls) expect(url).not.toContain('169.254');
  });

  it('runs the hostname guard before every fetch (v1 and v1alpha)', async () => {
    const order: string[] = [];
    const guard = vi.fn(async () => {
      order.push('guard');
    });
    const fetchImpl = vi.fn(async () => {
      order.push('fetch');
      return new Response(null, { status: 404 });
    });
    await post(fetchImpl, guard as never);
    expect(order).toEqual(['guard', 'fetch', 'guard', 'fetch']);
  });

  it('never fetches when the hostname guard rejects', async () => {
    const guard = vi.fn(async () => {
      throw new Error('blocked by dns guard');
    });
    const fetchImpl = vi.fn();
    const res = await post(fetchImpl, guard as never);
    expect(guard).toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(res.status).toBe(500);
  });
});
