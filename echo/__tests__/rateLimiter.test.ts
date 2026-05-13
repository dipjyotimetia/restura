// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import app from '../index';
import { resetRateLimiter } from '../middleware/rateLimiter';

function makeRequest(ip = '1.2.3.4') {
  return app.request('http://localhost/ping', {
    method: 'GET',
    headers: { 'CF-Connecting-IP': ip },
  });
}

beforeEach(() => {
  resetRateLimiter();
});

describe('echo rate limiter', () => {
  it('allows requests under the limit', async () => {
    const res = await makeRequest();
    expect(res.status).not.toBe(429);
  });

  it('returns 429 with Retry-After once the per-IP limit is exceeded', async () => {
    for (let i = 0; i < 100; i++) {
      await makeRequest();
    }
    const res = await makeRequest();
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/rate limit exceeded/i);
  });

  it('tracks IPs independently', async () => {
    for (let i = 0; i < 100; i++) {
      await makeRequest('10.0.0.1');
    }
    expect((await makeRequest('10.0.0.1')).status).toBe(429);
    expect((await makeRequest('10.0.0.2')).status).not.toBe(429);
  });

  it('falls back to "unknown" key when CF-Connecting-IP is absent', async () => {
    const res = await app.request('http://localhost/ping', { method: 'GET' });
    expect(res.status).not.toBe(429);
  });
});
