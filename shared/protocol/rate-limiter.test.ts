// @vitest-environment node
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIsolateRateLimiter } from './rate-limiter';

function appWith(limiter: ReturnType<typeof createIsolateRateLimiter>) {
  const app = new Hono();
  app.use('*', limiter.middleware);
  app.get('/', (c) => c.text('ok'));
  return (ip = '1.2.3.4') => app.request('/', { headers: { 'CF-Connecting-IP': ip } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createIsolateRateLimiter', () => {
  it('unblocks a client as soon as its own window has passed, not at the next global prune', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    // Long prune interval so the global sweep can't be what unblocks the client.
    const hit = appWith(createIsolateRateLimiter(2, 1_000, 60_000));

    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(429);

    now += 1_001; // window elapsed for both timestamps
    expect((await hit()).status).toBe(200);
  });

  it('slides: only timestamps still inside the window count', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const hit = appWith(createIsolateRateLimiter(2, 1_000, 60_000));

    expect((await hit()).status).toBe(200); // t=0
    now += 600;
    expect((await hit()).status).toBe(200); // t=600
    now += 500; // t=1100: the first has aged out, the second has not
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(429);
  });
});
