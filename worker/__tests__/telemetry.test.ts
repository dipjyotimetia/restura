// @vitest-environment node
import { describe, expect, it } from 'vitest';
import app from '../index';

const VALID_PAYLOAD = {
  message: 'render failed',
  stack: 'Error: render failed\n  at Component',
  source: 'error-boundary',
  build: 'production',
  ua: 'Mozilla/5.0',
  ts: 1_700_000_000_000,
};

// Development defaults remain useful for the validation-focused cases below.
const DEV_ENV = { ENVIRONMENT: 'development', DEV_BYPASS_AUTH: 'true' };

function post(body: unknown, env: Record<string, string> = DEV_ENV) {
  return app.request(
    '/api/telemetry/error',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env
  );
}

describe('POST /api/telemetry/error', () => {
  it('returns 202 and { ok: true } for a valid payload', async () => {
    const res = await post(VALID_PAYLOAD);
    expect(res.status).toBe(202);
    const json = await res.json<{ ok: boolean }>();
    expect(json.ok).toBe(true);
  });

  it('accepts opted-in telemetry in production without proxy credentials', async () => {
    const res = await post(VALID_PAYLOAD, { ENVIRONMENT: 'production' });
    expect(res.status).toBe(202);
  });

  it('rejects a payload missing a required field', async () => {
    const { source: _removed, ...noSource } = VALID_PAYLOAD;
    const res = await post(noSource);
    expect(res.status).toBe(400);
  });

  it('rejects an invalid source enum value', async () => {
    const res = await post({ ...VALID_PAYLOAD, source: 'crash' });
    expect(res.status).toBe(400);
  });

  it('rejects a message exceeding 2000 chars', async () => {
    const res = await post({ ...VALID_PAYLOAD, message: 'x'.repeat(2001) });
    expect(res.status).toBe(400);
  });

  it('rejects a stack exceeding 8000 chars', async () => {
    const res = await post({ ...VALID_PAYLOAD, stack: 'x'.repeat(8001) });
    expect(res.status).toBe(400);
  });

  it('rejects a ua exceeding 256 chars', async () => {
    const res = await post({ ...VALID_PAYLOAD, ua: 'x'.repeat(257) });
    expect(res.status).toBe(400);
  });

  it('rejects a body exceeding the 64 KB cap', async () => {
    const huge = {
      ...VALID_PAYLOAD,
      message: 'a'.repeat(2000),
      stack: 'b'.repeat(8000),
      componentStack: 'c'.repeat(55_000),
    };
    const res = await post(huge);
    // parseJsonBody returns 413 for oversized bodies.
    expect([400, 413]).toContain(res.status);
  });

  it('accepts optional fields (stack, componentStack)', async () => {
    const res = await post({ ...VALID_PAYLOAD, componentStack: '\n  at <App>' });
    expect(res.status).toBe(202);
  });

  it('accepts all three valid source values', async () => {
    for (const source of ['error-boundary', 'window-error', 'unhandled-rejection'] as const) {
      const res = await post({ ...VALID_PAYLOAD, source });
      expect(res.status).toBe(202);
    }
  });
});
