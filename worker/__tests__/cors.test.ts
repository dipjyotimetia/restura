// @vitest-environment node
import { describe, expect, it, vi, afterEach } from 'vitest';
import app from '../index';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('worker CORS', () => {
  it('allows Cloudflare Pages preview origins in production', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 200, statusText: 'OK' })),
    );

    const res = await app.request(
      '/api/proxy',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://feature-branch.restura.pages.dev',
        },
        body: JSON.stringify({ method: 'GET', url: 'https://example.com/api' }),
      },
      { ENVIRONMENT: 'production' },
    );

    expect(res.headers.get('access-control-allow-origin')).toBe('https://feature-branch.restura.pages.dev');
  });
});
