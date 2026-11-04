// @vitest-environment node
/**
 * DNS-rebinding defence for the DEV_BYPASS_AUTH mode. A page on
 * `http://attacker.example:3000` that rebinds its name to 127.0.0.1 is
 * same-origin with itself: Origin === `http://attacker.example:3000` and the
 * request URL host (taken from the attacker-controlled Host header) matches,
 * so the same-origin check alone let it drive the unauthenticated proxy.
 * In bypass mode the Host must be a loopback name.
 */
import { describe, expect, it } from 'vitest';
import { createApp } from '../app';
import type { Env } from '../env';

const app = createApp({ tcpProxy: {} as never, websocketHandler: (c) => c.text('x') });
const DEV_BYPASS: Partial<Env> = { ENVIRONMENT: 'development', DEV_BYPASS_AUTH: 'true' };

function postWsTicket(url: string, headers: Record<string, string> = {}) {
  return app.request(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ url: 'ws://127.0.0.1:9/' }),
    },
    DEV_BYPASS
  );
}

describe('dev-bypass Host allowlist (DNS rebinding)', () => {
  it.each([
    ['rebound name, same-origin Origin', 'http://attacker.example:3000/api/ws-ticket', {
      origin: 'http://attacker.example:3000',
    }],
    ['rebound name, no Origin (same-origin GET-style)', 'http://attacker.example:3000/api/ws-ticket', {}],
    ['LAN IP Host', 'http://192.168.1.20:3000/api/ws-ticket', { origin: 'http://192.168.1.20:3000' }],
  ])('refuses %s with 403', async (_label, url, headers) => {
    const res = await postWsTicket(url, headers);
    expect(res.status).toBe(403);
  });

  it.each([
    ['http://localhost:3000/api/ws-ticket', 'http://localhost:3000'],
    ['http://127.0.0.1:3000/api/ws-ticket', 'http://127.0.0.1:3000'],
    ['http://[::1]:3000/api/ws-ticket', 'http://[::1]:3000'],
  ])('lets a loopback Host through (%s)', async (url, origin) => {
    const res = await postWsTicket(url, { origin });
    expect(res.status).not.toBe(403);
  });

  it('does not apply the loopback Host rule outside bypass mode', async () => {
    const res = await app.request(
      'http://restura.corp.example/api/ws-ticket',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-restura-proxy-token': 't' },
        body: JSON.stringify({ url: 'wss://echo.example/' }),
      },
      { WORKER_PROXY_TOKEN: 't' }
    );
    expect(res.status).not.toBe(403);
  });
});
