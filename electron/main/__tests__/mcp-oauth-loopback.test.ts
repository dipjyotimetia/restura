// @vitest-environment node
import * as http from 'node:http';
import { describe, expect, it } from 'vitest';
import { OAuthCallbackError, startLoopbackReceiver } from '../security/mcp-oauth-loopback';

/** #856 RFC 8252 loopback receiver: exact state, single use, Host check, timeout, abort. */

function get(url: string, host?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { headers: host ? { host } : {} }, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('startLoopbackReceiver', () => {
  it('binds 127.0.0.1 on an ephemeral port with the callback path', async () => {
    const r = await startLoopbackReceiver();
    expect(r.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
    expect(r.port).toBeGreaterThan(0);
    r.close();
  });

  it('ignores a wrong state and resolves on the exact one, then closes (single use)', async () => {
    const r = await startLoopbackReceiver();
    const wait = r.waitForCallback('expected-state-123');
    const wrong = await get(`${r.redirectUrl}?code=evil&state=nope`);
    expect(wrong.status).toBe(400);
    const missing = await get(`${r.redirectUrl}?code=evil`);
    expect(missing.status).toBe(400);
    const ok = await get(`${r.redirectUrl}?code=the-code&state=expected-state-123&iss=x`);
    expect(ok.status).toBe(200);
    const params = await wait;
    expect(params.get('code')).toBe('the-code');
    expect(params.get('iss')).toBe('x');
    await expect(get(`${r.redirectUrl}?code=again&state=expected-state-123`)).rejects.toThrow();
  });

  it('accepts a callback that arrives before the caller awaits it', async () => {
    const r = await startLoopbackReceiver();
    const wait = r.waitForCallback('s1');
    await get(`${r.redirectUrl}?code=early&state=s1`);
    expect((await wait).get('code')).toBe('early');
  });

  it('rejects a foreign Host header (DNS rebinding)', async () => {
    const r = await startLoopbackReceiver();
    const wait = r.waitForCallback('s2');
    const res = await get(`${r.redirectUrl}?code=c&state=s2`, 'evil.example');
    expect(res.status).toBe(400);
    r.close();
    await expect(wait).rejects.toBeInstanceOf(OAuthCallbackError);
  });

  it('404s other paths and methods', async () => {
    const r = await startLoopbackReceiver();
    r.waitForCallback('s3').catch(() => undefined);
    const res = await get(`http://127.0.0.1:${r.port}/other?state=s3&code=c`);
    expect(res.status).toBe(404);
    r.close();
  });

  it('surfaces only a sanitised AS error code', async () => {
    const r = await startLoopbackReceiver();
    const wait = r.waitForCallback('s4');
    wait.catch(() => undefined);
    await get(
      `${r.redirectUrl}?state=s4&error=access_denied%3Cscript%3E&error_description=${encodeURIComponent('click evil.example')}`
    );
    await expect(wait).rejects.toThrow('Authorization was denied: access_deniedscript');
    await expect(wait).rejects.not.toThrow(/evil/);
  });

  it('errors when the callback carries no code', async () => {
    const r = await startLoopbackReceiver();
    const wait = r.waitForCallback('s5');
    wait.catch(() => undefined);
    await get(`${r.redirectUrl}?state=s5`);
    await expect(wait).rejects.toThrow(/no code/);
  });

  it('times out', async () => {
    const r = await startLoopbackReceiver({ timeoutMs: 30 });
    await expect(r.waitForCallback('s6')).rejects.toThrow(/timed out/);
  });

  it('cancels on abort and refuses a second wait', async () => {
    const controller = new AbortController();
    const r = await startLoopbackReceiver({ signal: controller.signal });
    const wait = r.waitForCallback('s7');
    await expect(r.waitForCallback('other')).rejects.toThrow(/single-use/);
    controller.abort();
    await expect(wait).rejects.toThrow(/cancelled/);
  });

  it('refuses to start on an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(startLoopbackReceiver({ signal: controller.signal })).rejects.toThrow(/cancelled/);
  });

  it('rejects when a pinned port is taken', async () => {
    const r = await startLoopbackReceiver();
    await expect(startLoopbackReceiver({ port: r.port })).rejects.toThrow();
    r.close();
  });
});
