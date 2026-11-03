// @vitest-environment node

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../env';
import app from '../index';
import {
  rateLimitMiddleware,
  resetRateLimiter,
  socketClientIpMiddleware,
} from '../middleware/rateLimiter';

// Signature verification is cf-access.test.ts's job; here the assertion is
// "valid" and only its claims matter, because the bucket must key on them.
vi.mock('../shared/cf-access', () => ({
  readCfAccessConfig: () => ({ teamDomain: 'team.example', aud: 'aud' }),
  verifyCfAccessAssertion: async (assertion: string | undefined) => Boolean(assertion),
}));

const ACCESS_ENV: Env = { ENVIRONMENT: 'production', REQUIRE_CF_ACCESS: 'true' };

const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const assertionFor = (sub: string) =>
  `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify({ sub, email: `${sub}@x.example` }))}.sig`;

/** An authenticated, cheap /api route (426 without an Upgrade header). */
function hit(sub: string, extra: Record<string, string> = {}) {
  return app.request(
    '/api/ws',
    {
      headers: {
        'CF-Connecting-IP': '203.0.113.7',
        'Cf-Access-Jwt-Assertion': assertionFor(sub),
        ...extra,
      },
    },
    ACCESS_ENV
  );
}

beforeEach(() => {
  resetRateLimiter();
});

describe('rate-limit bucket keys on the authenticated principal', () => {
  it('a client cannot mint fresh buckets with a made-up proxy token (CF Access mode)', async () => {
    for (let i = 0; i < 100; i++) {
      const res = await hit('alice', { 'X-Restura-Proxy-Token': `junk-${i}` });
      expect(res.status).toBe(426);
    }
    const res = await hit('alice', { 'X-Restura-Proxy-Token': 'junk-final' });
    expect(res.status).toBe(429);
  });

  it('distinct CF Access subjects behind one IP get distinct buckets', async () => {
    for (let i = 0; i < 100; i++) await hit('alice');
    expect((await hit('alice')).status).toBe(429);
    expect((await hit('bob')).status).toBe(426);
  });
});

describe('self-host client address (socketClientIpMiddleware)', () => {
  function nodeApp(trustProxy: boolean) {
    const a = new Hono<{ Bindings: Env }>();
    a.use(
      '*',
      socketClientIpMiddleware(() => '198.51.100.9', trustProxy)
    );
    a.use('*', rateLimitMiddleware);
    a.get('/x', (c) => c.text('ok'));
    return a;
  }
  const spoofed = (a: Hono<{ Bindings: Env }>, i: number) =>
    a.request('/x', { headers: { 'True-Client-IP': `10.0.0.${i % 250}` } }, {});

  it('ignores client-supplied forwarding headers unless TRUST_PROXY is set', async () => {
    const a = nodeApp(false);
    for (let i = 0; i < 100; i++) expect((await spoofed(a, i)).status).toBe(200);
    expect((await spoofed(a, 100)).status).toBe(429);
  });

  it('honours forwarding headers behind a trusted proxy', async () => {
    const a = nodeApp(true);
    for (let i = 0; i < 101; i++) expect((await spoofed(a, i)).status).toBe(200);
  });
});
