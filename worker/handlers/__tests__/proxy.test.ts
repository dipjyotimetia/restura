// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { createProxyHandler } from '../proxy';

// The CONNECT-proxy adapter is never exercised by these tests (no
// upstreamProxy in any request body). Inject a throwing stub so a regression
// that accidentally routes through it surfaces loudly.
const tcpProxyStub = {
  httpsViaConnectProxy: () => {
    throw new Error('httpsViaConnectProxy unexpectedly called in unit test');
  },
  httpViaProxy: () => {
    throw new Error('httpViaProxy unexpectedly called in unit test');
  },
};

const app = new Hono<{ Bindings: { ENVIRONMENT?: string } }>();
app.post('/proxy', createProxyHandler(tcpProxyStub));

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

  it('malformed JSON body returns 400 with Malformed JSON error', async () => {
    const res = await app.request(
      '/proxy',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
      },
      {},
    );
    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect(json.error).toMatch(/Malformed JSON/);
  });

  it('schema violation (missing required field) returns 400 with Invalid request body error', async () => {
    const res = await makeRequest({ url: 'https://example.com/api' }); // missing method
    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect(json.error).toMatch(/Invalid request body/);
    expect(json.error).toMatch(/method/i);
  });

  it('private IP 192.168.1.1 is blocked and returns 400 with Invalid URL error', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const res = await makeRequest({ method: 'GET', url: 'http://192.168.1.1/' });
    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect(json.error).toMatch(/Invalid URL/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('localhost allowed in development with DEV_BYPASS_AUTH binding', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('{}', { status: 200, statusText: 'OK' }),
    );
    vi.stubGlobal('fetch', mockFetch);

    // Per Task 2.6 unification: ENVIRONMENT=development alone no longer
    // relaxes allowLocalhost. Requires DEV_BYPASS_AUTH=true (or Miniflare).
    const res = await makeRequest(
      { method: 'GET', url: 'http://localhost:3000/' },
      { ENVIRONMENT: 'development', DEV_BYPASS_AUTH: 'true' },
    );
    expect(mockFetch).toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it('localhost blocked in ENVIRONMENT=development WITHOUT DEV_BYPASS_AUTH', async () => {
    // Critical regression guard: a preview deploy that inherits
    // ENVIRONMENT=development MUST NOT relax SSRF guards.
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const res = await makeRequest(
      { method: 'GET', url: 'http://localhost:3000/' },
      { ENVIRONMENT: 'development' },
    );
    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
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

  describe('streaming proxy', () => {
    it('forwards a text/event-stream upstream as a streamed Response', async () => {
      const upstreamBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: a\n\n'));
          controller.enqueue(new TextEncoder().encode('data: b\n\n'));
          controller.close();
        },
      });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(upstreamBody, {
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'text/event-stream' },
          }),
        ),
      );

      const res = await makeRequest({
        method: 'GET',
        url: 'https://example.com/sse',
        headers: { Accept: 'text/event-stream' },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const text = await res.text();
      expect(text).toContain('data: a');
      expect(text).toContain('data: b');
    });

    it('forwards an application/x-ndjson upstream as a streamed Response', async () => {
      const upstreamBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"a":1}\n'));
          controller.enqueue(new TextEncoder().encode('{"b":2}\n'));
          controller.close();
        },
      });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(upstreamBody, {
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'application/x-ndjson' },
          }),
        ),
      );

      const res = await makeRequest({
        method: 'GET',
        url: 'https://example.com/ndjson',
        headers: { Accept: 'application/x-ndjson' },
      });

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('"a":1');
      expect(text).toContain('"b":2');
    });

    it('falls back to buffered path when Accept does not indicate streaming', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response('{"hello":"world"}', {
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'application/json' },
          }),
        ),
      );

      const res = await makeRequest({
        method: 'GET',
        url: 'https://example.com/json',
        headers: { Accept: 'application/json' },
      });

      // Buffered path returns the worker's JSON envelope, not the raw body
      const json = (await res.json()) as { status: number; data: string };
      expect(json.status).toBe(200);
      expect(json.data).toContain('hello');
    });

    it('does not match Accept: text/event-stream-evil as streaming', async () => {
      // If the substring-based check were still in place, `text/event-stream-evil`
      // would be routed through the streaming pass-through (which skips the
      // buffered-response size cap). With proper token-parsing, this falls back
      // to the buffered path, which returns a Hono JSON envelope.
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response('{"hello":"world"}', {
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'application/json' },
          }),
        ),
      );

      const res = await makeRequest({
        method: 'GET',
        url: 'https://example.com/api',
        headers: { Accept: 'text/event-stream-evil' },
      });

      // Buffered path uses Hono's c.json() which sets application/json.
      const contentType = res.headers.get('content-type') ?? '';
      expect(contentType).toMatch(/application\/json/);
      const json = (await res.json()) as { status: number; data: string };
      expect(json.status).toBe(200);
      expect(json.data).toContain('hello');
    });

    it('matches Accept: text/event-stream; q=0.9 as streaming (strips params)', async () => {
      const upstreamBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: x\n\n'));
          controller.close();
        },
      });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(upstreamBody, {
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'text/event-stream' },
          }),
        ),
      );

      const res = await makeRequest({
        method: 'GET',
        url: 'https://example.com/sse',
        headers: { Accept: 'text/event-stream; q=0.9' },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const text = await res.text();
      expect(text).toContain('data: x');
    });

    it('matches second media type in a comma-separated Accept list', async () => {
      const upstreamBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: y\n\n'));
          controller.close();
        },
      });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(upstreamBody, {
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'text/event-stream' },
          }),
        ),
      );

      const res = await makeRequest({
        method: 'GET',
        url: 'https://example.com/sse',
        headers: { Accept: 'application/json, text/event-stream' },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
    });

    it('matches uppercase Accept value (case-insensitive)', async () => {
      const upstreamBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: z\n\n'));
          controller.close();
        },
      });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(upstreamBody, {
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'text/event-stream' },
          }),
        ),
      );

      const res = await makeRequest({
        method: 'GET',
        url: 'https://example.com/sse',
        headers: { Accept: 'TEXT/EVENT-STREAM' },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
    });

    it('streamingMode flag forces the streaming path even for unknown content types', async () => {
      const upstreamBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('chunk1'));
          controller.close();
        },
      });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(upstreamBody, {
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'text/plain' },
          }),
        ),
      );

      const res = await makeRequest({
        method: 'GET',
        url: 'https://example.com/raw',
        streamingMode: true,
      });

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe('chunk1');
    });
  });
});
