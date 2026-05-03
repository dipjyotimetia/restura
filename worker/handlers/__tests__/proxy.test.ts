// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { proxy } from '../proxy';

const app = new Hono<{ Bindings: { ENVIRONMENT?: string } }>();
app.post('/proxy', proxy);

function makeRequest(body: unknown, env: Record<string, string> = {}) {
  return app.request(
    '/proxy',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('proxy handler', () => {
  describe('valid GET request', () => {
    beforeEach(() => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ hello: 'world' }), {
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'application/json' },
          }),
        ),
      );
    });

    it('returns status, statusText, headers, data, and size', async () => {
      const res = await makeRequest({ method: 'GET', url: 'https://example.com/api' });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveProperty('status', 200);
      expect(json).toHaveProperty('statusText', 'OK');
      expect(json).toHaveProperty('headers');
      expect(json).toHaveProperty('data');
      expect(json).toHaveProperty('size');
    });
  });

  it('disallowed method CONNECT returns 400', async () => {
    const res = await makeRequest({ method: 'CONNECT', url: 'https://example.com/api' });
    expect(res.status).toBe(400);
  });

  it('private IP 192.168.1.1 is blocked and returns 400 with Invalid URL error', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const res = await makeRequest({ method: 'GET', url: 'http://192.168.1.1/' });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/Invalid URL/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('localhost allowed in development environment', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('{}', { status: 200, statusText: 'OK' }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const res = await makeRequest(
      { method: 'GET', url: 'http://localhost:3000/' },
      { ENVIRONMENT: 'development' },
    );
    expect(mockFetch).toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it('localhost blocked in production environment returns 400', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const res = await makeRequest(
      { method: 'GET', url: 'http://localhost:3000/' },
      { ENVIRONMENT: 'production' },
    );
    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('localhost blocked when no env is set', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const res = await makeRequest({ method: 'GET', url: 'http://localhost:3000/' });
    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('blocked request headers are not forwarded to upstream fetch', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
        capturedHeaders = opts.headers as Record<string, string>;
        return Promise.resolve(new Response('{}', { status: 200, statusText: 'OK' }));
      }),
    );

    await makeRequest({
      method: 'GET',
      url: 'https://example.com/api',
      headers: { host: 'evil.com', 'x-custom': 'keep-me' },
    });

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders!['host']).toBeUndefined();
    expect(capturedHeaders!['x-custom']).toBe('keep-me');
  });

  it('response too large via content-length header returns 413', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('{}', {
          status: 200,
          statusText: 'OK',
          headers: { 'content-length': String(11 * 1024 * 1024) },
        }),
      ),
    );

    const res = await makeRequest({ method: 'GET', url: 'https://example.com/api' });
    expect(res.status).toBe(413);
  });

  it('fetch AbortError returns 504', async () => {
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));

    const res = await makeRequest({ method: 'GET', url: 'https://example.com/api' });
    expect(res.status).toBe(504);
  });

  it('fetch network error returns 502', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network failure')));

    const res = await makeRequest({ method: 'GET', url: 'https://example.com/api' });
    expect(res.status).toBe(502);
  });
});
