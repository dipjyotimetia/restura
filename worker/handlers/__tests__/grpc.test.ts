// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { grpc } from '../grpc';

const app = new Hono<{ Bindings: { ENVIRONMENT?: string } }>();
app.post('/grpc', grpc);

function makeRequest(body: unknown, env: Record<string, string> = {}) {
  return app.request(
    '/grpc',
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

describe('grpc handler', () => {
  it('valid request returns grpcStatus 0 and grpcStatusText OK', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ result: 'ok' }), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const res = await makeRequest({
      url: 'https://api.example.com',
      service: 'helloworld.Greeter',
      method: 'SayHello',
      message: { name: 'world' },
    });

    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.grpcStatus).toBe(0);
    expect(json.grpcStatusText).toBe('OK');
  });

  it('invalid URL returns 400 with Invalid URL error', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const res = await makeRequest({
      url: 'not-a-url',
      service: 'helloworld.Greeter',
      method: 'SayHello',
    });

    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect(json.error).toMatch(/Invalid URL/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('invalid service name returns 400 with Invalid service error', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const res = await makeRequest({
      url: 'https://api.example.com',
      service: '123invalid',
      method: 'SayHello',
    });

    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect(json.error).toMatch(/Invalid service/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('invalid method name returns 400 with Invalid method error', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const res = await makeRequest({
      url: 'https://api.example.com',
      service: 'helloworld.Greeter',
      method: 'bad-method',
    });

    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect(json.error).toMatch(/Invalid method/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('blocked metadata header host is not forwarded to upstream fetch', async () => {
    let capturedHeaders: HeadersInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
        capturedHeaders = opts.headers;
        return Promise.resolve(
          new Response(JSON.stringify({ result: 'ok' }), { status: 200, statusText: 'OK' }),
        );
      }),
    );

    await makeRequest({
      url: 'https://api.example.com',
      service: 'helloworld.Greeter',
      method: 'SayHello',
      metadata: { host: 'evil.com', 'x-request-id': 'abc123' },
    });

    const headers = capturedHeaders as Record<string, string>;
    expect(headers['host']).toBeUndefined();
    expect(headers['x-request-id']).toBe('abc123');
  });

  it('connect error response not_found maps to grpcStatus 5 (NOT_FOUND)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: 'not_found', message: 'not found' }), {
          status: 400,
          statusText: 'Bad Request',
        }),
      ),
    );

    const res = await makeRequest({
      url: 'https://api.example.com',
      service: 'helloworld.Greeter',
      method: 'SayHello',
    });

    const json = await res.json() as Record<string, unknown>;
    expect(json.grpcStatus).toBe(5);
  });

  it('AbortError returns 504 with grpcStatusText DEADLINE_EXCEEDED', async () => {
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));

    const res = await makeRequest({
      url: 'https://api.example.com',
      service: 'helloworld.Greeter',
      method: 'SayHello',
    });

    expect(res.status).toBe(504);
    const json = await res.json() as Record<string, unknown>;
    expect(json.grpcStatusText).toBe('DEADLINE_EXCEEDED');
  });

  it('constructs fetch URL as baseUrl/service/method', async () => {
    let capturedUrl: string | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        capturedUrl = url;
        return Promise.resolve(
          new Response(JSON.stringify({ result: 'ok' }), { status: 200, statusText: 'OK' }),
        );
      }),
    );

    await makeRequest({
      url: 'https://api.example.com',
      service: 'helloworld.Greeter',
      method: 'SayHello',
    });

    expect(capturedUrl).toBe('https://api.example.com/helloworld.Greeter/SayHello');
  });
});
