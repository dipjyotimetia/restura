// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
import app from '../index';

function makeRequest(ip = '1.2.3.4') {
  return app.request('http://localhost/ping', {
    method: 'GET',
    headers: { 'CF-Connecting-IP': ip },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('echo rate limiter', () => {
  it('allows requests under the limit', async () => {
    const res = await makeRequest('10.0.0.1');
    expect(res.status).not.toBe(429);
  });

  it('returns 429 with Retry-After once the per-IP limit is exceeded', async () => {
    const ip = '10.0.0.2';
    // Exhaust the 100-request window.
    for (let i = 0; i < 100; i++) {
      await makeRequest(ip);
    }

    const res = await makeRequest(ip);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/rate limit exceeded/i);
  });

  it('tracks IPs independently', async () => {
    const ipA = '10.0.0.3';
    const ipB = '10.0.0.4';

    for (let i = 0; i < 100; i++) {
      await makeRequest(ipA);
    }

    // ipA is exhausted, ipB has not been seen yet.
    expect((await makeRequest(ipA)).status).toBe(429);
    expect((await makeRequest(ipB)).status).not.toBe(429);
  });

  it('falls back to "unknown" key when CF-Connecting-IP is absent', async () => {
    const res = await app.request('http://localhost/ping', { method: 'GET' });
    expect(res.status).not.toBe(429);
  });
});
