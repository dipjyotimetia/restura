// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';

// Reproduce the env-injection middleware from worker/node-entry.ts inline
// (its `serve()` side effects make the file unimportable in unit tests).
// Pin: must Object.assign onto the existing c.env, NOT replace it. @hono/
// node-ws stamps `incoming` + symbol-keyed connection tokens onto the env
// reference it passes through; if we reassign, those refs are orphaned and
// every WebSocket upgrade silently fails.
function buildEnvInjectionMiddleware() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (c: any, next: () => Promise<void>) => {
    const additions = {
      ENVIRONMENT: 'production',
      ALLOWED_ORIGIN: 'https://restura.corp',
    };
    if (c.env) {
      Object.assign(c.env, additions);
    } else {
      c.env = additions;
    }
    await next();
  };
}

describe('node-entry env-injection middleware (Fix #1)', () => {
  it('preserves pre-existing c.env properties when adding process.env values', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = new Hono<any>();
    app.use('*', buildEnvInjectionMiddleware());
    app.get('/echo', (c) => c.json({ env: c.env }));

    // Simulate @hono/node-ws stamping an `incoming` reference onto the env.
    const stamped = Symbol('connection');
    const envIn = {
      incoming: { url: '/echo' },
      [stamped]: 'token-xyz',
    };
    const res = await app.request('/echo', { method: 'GET' }, envIn);
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as { env: any };

    // The pre-existing keys must still be present after the middleware ran
    // (verified through JSON; Symbol-keyed entries don't survive JSON so we
    // check them on the source object below).
    expect(body.env.incoming).toEqual({ url: '/echo' });
    // The additions must also be merged in.
    expect(body.env.ENVIRONMENT).toBe('production');
    expect(body.env.ALLOWED_ORIGIN).toBe('https://restura.corp');

    // The env reference passed in MUST be the same object (mutation, not
    // replacement) — this is the actual invariant @hono/node-ws relies on.
    // Symbol-keyed entries survive Object.assign and are still present on
    // the original reference.
    expect(envIn).toMatchObject({
      incoming: { url: '/echo' },
      ENVIRONMENT: 'production',
      ALLOWED_ORIGIN: 'https://restura.corp',
    });
    expect((envIn as Record<symbol, unknown>)[stamped]).toBe('token-xyz');
  });

  it('initialises c.env when none was provided', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = new Hono<any>();
    app.use('*', buildEnvInjectionMiddleware());
    app.get('/echo', (c) => c.json({ env: c.env }));

    const res = await app.request('/echo', { method: 'GET' });
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as { env: any };
    expect(body.env.ENVIRONMENT).toBe('production');
  });
});
