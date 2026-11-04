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

  it('sends every fetch (v1 and v1alpha) through the injected Node pinned fetch over h2', async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal('fetch', globalFetch);
    const nodeFetch = vi.fn(async () => new Response(null, { status: 404 }));
    const app = new Hono();
    app.post('/r', createGrpcReflectionHandler(nodeFetch));
    await app.request(
      '/r',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://grpc.example.com', request: { listServices: '' } }),
      },
      {}
    );
    vi.unstubAllGlobals();
    expect(nodeFetch).toHaveBeenCalledTimes(2);
    for (const call of nodeFetch.mock.calls as unknown as Array<[string, RequestInit, object]>) {
      expect(call[2]).toEqual({ allowLocalhost: false, allowPrivateIPs: false, http2: true });
    }
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('surfaces a pinned-fetch (SSRF guard) refusal as an error', async () => {
    const nodeFetch = vi.fn(async () => {
      throw new Error('blocked by dns guard');
    });
    const app = new Hono();
    app.post('/r', createGrpcReflectionHandler(nodeFetch));
    const res = await app.request(
      '/r',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://grpc.example.com', request: { listServices: '' } }),
      },
      {}
    );
    expect(nodeFetch).toHaveBeenCalled();
    expect(res.status).toBe(500);
  });
});
