// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { grpcReflection } from '../grpc-reflection';

const app = new Hono<{ Bindings: { ENVIRONMENT?: string } }>();
app.post('/grpc/reflection', grpcReflection);

function makeRequest(body: unknown, env: Record<string, string> = {}) {
  return app.request(
    '/grpc/reflection',
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

describe('grpcReflection handler', () => {
  it('successful v1 reflection returns reflectionVersion v1', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ services: ['helloworld.Greeter'] }), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const res = await makeRequest({
      url: 'https://api.example.com',
      request: { listServices: '' },
    });

    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.reflectionVersion).toBe('v1');
    expect(json.services).toEqual(['helloworld.Greeter']);
  });

  it('v1 fails and v1alpha succeeds returns reflectionVersion v1alpha', async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('v1 not implemented'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ services: ['helloworld.Greeter'] }), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', mockFetch);

    const res = await makeRequest({
      url: 'https://api.example.com',
      request: { listServices: '' },
    });

    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.reflectionVersion).toBe('v1alpha');
  });

  it('both v1 and v1alpha fail returns 500 with both error messages', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValueOnce(new Error('v1 error'))
        .mockRejectedValueOnce(new Error('v1alpha error')),
    );

    const res = await makeRequest({
      url: 'https://api.example.com',
      request: { listServices: '' },
    });

    expect(res.status).toBe(500);
    const json = await res.json() as Record<string, unknown>;
    expect(json.error).toMatch(/v1 error/);
    expect(json.error).toMatch(/v1alpha error/);
  });

  it('malformed JSON body returns 400 with Malformed JSON error', async () => {
    const res = await app.request(
      '/grpc/reflection',
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

  it('schema violation (missing request) returns 400 with Invalid request body error', async () => {
    const res = await makeRequest({ url: 'https://api.example.com' }); // missing `request`
    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect(json.error).toMatch(/Invalid request body/);
    expect(json.error).toMatch(/request/i);
  });

  it('invalid URL returns 400', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const res = await makeRequest({
      url: 'not-a-url',
      request: { listServices: '' },
    });

    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('v1 AbortError falls through to v1alpha and succeeds', async () => {
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(abortError)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ services: ['helloworld.Greeter'] }), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', mockFetch);

    const res = await makeRequest({
      url: 'https://api.example.com',
      request: { listServices: '' },
    });

    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.reflectionVersion).toBe('v1alpha');
  });
});
