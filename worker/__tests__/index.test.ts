// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import app from '../index';
import type { Env } from '../index';

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
  delete (globalThis as { MINIFLARE?: unknown }).MINIFLARE;
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

describe('proxyAuthMiddleware', () => {
  it('returns 503 when ENVIRONMENT=development but Miniflare is not running and no token configured', async () => {
    const env: Env = { ENVIRONMENT: 'development' };
    const res = await app.request(
      '/api/proxy',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'GET', url: 'https://example.com' }),
      },
      env,
    );
    expect(res.status).toBe(503);
  });

  it('skips auth when DEV_BYPASS_AUTH binding is true and ENVIRONMENT=development', async () => {
    const env: Env = { ENVIRONMENT: 'development', DEV_BYPASS_AUTH: 'true' };
    const res = await app.request(
      '/api/proxy',
      {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:5173' },
      },
      env,
    );
    // OPTIONS should pass CORS preflight; auth middleware should not block.
    expect([200, 204]).toContain(res.status);
  });

  it('rejects DEV_BYPASS_AUTH=true in non-development environment', async () => {
    const env: Env = { ENVIRONMENT: 'production', DEV_BYPASS_AUTH: 'true' };
    const res = await app.request(
      '/api/proxy',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'GET', url: 'https://example.com' }),
      },
      env,
    );
    expect(res.status).toBe(503); // or 401 — bypass MUST NOT apply
  });

  // Critical bypass-rejection: a preview deploy that inherited
  // ENVIRONMENT=development (no Miniflare, no explicit DEV_BYPASS_AUTH binding)
  // MUST still require the configured proxy token. If isLocalDevBypass were
  // ever loosened to "ENVIRONMENT === 'development'" alone, this test fails.
  it('still requires the proxy token in ENVIRONMENT=development without Miniflare or DEV_BYPASS_AUTH', async () => {
    const env: Env = { ENVIRONMENT: 'development', WORKER_PROXY_TOKEN: 'secret-token' };
    const res = await app.request(
      '/api/proxy',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'GET', url: 'https://example.com' }),
      },
      env,
    );
    // No token header sent — auth middleware MUST reject (401), not bypass.
    expect(res.status).toBe(401);
  });
});

describe('Miniflare detection', () => {
  afterEach(() => {
    delete (globalThis as { MINIFLARE?: unknown }).MINIFLARE;
  });

  it('skips auth when running under Miniflare even without DEV_BYPASS_AUTH', async () => {
    (globalThis as { MINIFLARE?: unknown }).MINIFLARE = true;
    const env: Env = { ENVIRONMENT: 'development' };
    const res = await app.request(
      '/api/proxy',
      {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:5173' },
      },
      env,
    );
    expect([200, 204]).toContain(res.status);
  });
});
