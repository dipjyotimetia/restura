// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import app from '../index';

function makeApiRequest(
  headers: Record<string, string> = {},
  env: Record<string, string> = {},
) {
  return app.request(
    '/api/proxy',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ method: 'GET', url: 'https://example.com/api' }),
    },
    env,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('worker api middleware', () => {
  it('fails closed outside development when proxy auth is not configured', async () => {
    const res = await makeApiRequest({}, { ENVIRONMENT: 'production' });
    expect(res.status).toBe(503);
  });

  it('accepts matching proxy token outside development', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 200, statusText: 'OK' })),
    );

    const res = await makeApiRequest(
      { 'X-Restura-Proxy-Token': 'secret-token' },
      { ENVIRONMENT: 'production', WORKER_PROXY_TOKEN: 'secret-token' },
    );

    expect(res.status).toBe(200);
  });

  it('rejects mismatched proxy token outside development', async () => {
    const res = await makeApiRequest(
      { 'X-Restura-Proxy-Token': 'wrong-token' },
      { ENVIRONMENT: 'production', WORKER_PROXY_TOKEN: 'secret-token' },
    );

    expect(res.status).toBe(401);
  });

  it('allows configured preview origins and denies other origins', async () => {
    const allowed = await app.request(
      '/api/proxy',
      { method: 'OPTIONS', headers: { Origin: 'https://feature.restura.pages.dev' } },
      { ENVIRONMENT: 'preview', ALLOWED_ORIGIN: 'https://*.restura.pages.dev' },
    );
    const denied = await app.request(
      '/api/proxy',
      { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } },
      { ENVIRONMENT: 'preview', ALLOWED_ORIGIN: 'https://*.restura.pages.dev' },
    );

    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://feature.restura.pages.dev');
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });
});
