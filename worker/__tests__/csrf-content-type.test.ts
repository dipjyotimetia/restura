// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../env';
import app from '../index';

/**
 * CSRF hardening for the JSON `/api/*` POST routes. A `text/plain` (or form)
 * POST is a CORS "simple request": the browser sends it cross-origin WITHOUT
 * a preflight, so a hostile page could drive the proxy at localhost services
 * whenever auth is bypassed (local dev / `DEV_BYPASS_AUTH`). Requiring
 * `application/json` forces a preflight that CORS then refuses.
 */

const DEV_BYPASS: Partial<Env> = { ENVIRONMENT: 'development', DEV_BYPASS_AUTH: 'true' };
const TOKEN_ENV: Partial<Env> = { ENVIRONMENT: 'production', WORKER_PROXY_TOKEN: 'secret-token' };

const proxyBody = JSON.stringify({ method: 'GET', url: 'http://127.0.0.1:9/' });

function post(
  path: string,
  headers: Record<string, string>,
  env: Partial<Env>,
  body: string = proxyBody
) {
  return app.request(path, { method: 'POST', headers, body }, env);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/api/* JSON POST routes require application/json', () => {
  const routes = [
    '/api/proxy',
    '/api/import/fetch',
    '/api/grpc',
    '/api/grpc/reflection',
    '/api/grpc-web',
    '/api/mcp',
    '/api/mcp/terminate',
    '/api/ws-ticket',
    '/api/telemetry/error',
  ];

  it.each(routes)('rejects a text/plain POST to %s with 415 (dev bypass)', async (route) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('pwned'));
    vi.stubGlobal('fetch', fetchMock);
    const res = await post(route, { 'Content-Type': 'text/plain' }, DEV_BYPASS);
    expect(res.status).toBe(415);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    'text/plain;charset=UTF-8',
    'application/x-www-form-urlencoded',
    'multipart/form-data; boundary=x',
    'application/jsonp',
    'application/json-seq',
  ])('rejects Content-Type %s on /api/proxy', async (contentType) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await post('/api/proxy', { 'Content-Type': contentType }, DEV_BYPASS);
    expect(res.status).toBe(415);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a POST with no Content-Type', async () => {
    const res = await post('/api/proxy', {}, DEV_BYPASS);
    expect(res.status).toBe(415);
  });

  it('rejects a cross-site text/plain POST even with a valid token', async () => {
    const res = await post(
      '/api/proxy',
      { 'Content-Type': 'text/plain', 'X-Restura-Proxy-Token': 'secret-token' },
      TOKEN_ENV
    );
    expect(res.status).toBe(415);
  });

  it.each([
    'application/json',
    'application/json; charset=utf-8',
    'Application/JSON;charset=UTF-8',
  ])('accepts Content-Type %s', async (contentType) => {
    const res = await post(
      '/api/telemetry/error',
      { 'Content-Type': contentType },
      DEV_BYPASS,
      JSON.stringify({ message: 'boom', source: 'window-error', ts: 1 })
    );
    expect(res.status).not.toBe(415);
  });

  it('keeps GET routes free of the Content-Type requirement', async () => {
    const res = await app.request('/api/feature-flags', { method: 'GET' }, DEV_BYPASS);
    expect(res.status).toBe(200);
  });
});

describe('auth-bypass mode refuses foreign origins', () => {
  it('rejects a POST from a non-allowed Origin with 403 and never calls upstream', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('pwned'));
    vi.stubGlobal('fetch', fetchMock);
    const res = await post(
      '/api/proxy',
      { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      DEV_BYPASS
    );
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows the Vite dev origin', async () => {
    const res = await post(
      '/api/telemetry/error',
      { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
      DEV_BYPASS,
      JSON.stringify({ message: 'boom', source: 'window-error', ts: 1 })
    );
    expect(res.status).not.toBe(403);
  });

  it('allows a same-origin request (self-host SPA served by the same server)', async () => {
    const res = await app.request(
      'http://localhost:3000/api/telemetry/error',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' },
        body: JSON.stringify({ message: 'boom', source: 'window-error', ts: 1 }),
      },
      DEV_BYPASS
    );
    expect(res.status).not.toBe(403);
  });

  it('allows an Origin listed in ALLOWED_ORIGIN', async () => {
    const res = await post(
      '/api/telemetry/error',
      { 'Content-Type': 'application/json', Origin: 'https://restura.internal' },
      { ...DEV_BYPASS, ALLOWED_ORIGIN: 'https://restura.internal' },
      JSON.stringify({ message: 'boom', source: 'window-error', ts: 1 })
    );
    expect(res.status).not.toBe(403);
  });

  it('allows requests with no Origin (curl, server-to-server)', async () => {
    const res = await post(
      '/api/telemetry/error',
      { 'Content-Type': 'application/json' },
      DEV_BYPASS,
      JSON.stringify({ message: 'boom', source: 'window-error', ts: 1 })
    );
    expect(res.status).not.toBe(403);
  });
});
