import { test, expect } from './fixtures/servers';

/**
 * Advanced HTTP scenarios at the wire level — the kinds of edge cases that
 * surface real bugs in client code: cookie jars, Set-Cookie semantics, auth
 * challenges, gzip decoding, multipart bodies, redirect chains across hosts.
 *
 * UI-level coverage of these would require deep Playwright orchestration of
 * Restura's settings; the wire layer tests are what catches regressions in
 * the renderer's `executeRequest` and the worker's proxy logic.
 */
test.describe('HTTP — cookies', () => {
  test('Set-Cookie returns multiple cookies with attributes', async ({ servers }) => {
    const res = await fetch(`${servers.http.url}/cookies/set?token=abc&theme=dark`);
    const setCookie = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
    expect(setCookie.length).toBeGreaterThanOrEqual(2);
    expect(setCookie.some((c) => c.startsWith('token=abc'))).toBe(true);
    expect(setCookie.some((c) => c.startsWith('theme=dark'))).toBe(true);
    expect(setCookie.every((c) => /SameSite=Lax/i.test(c))).toBe(true);
  });

  test('echoes a Cookie header back to the caller', async ({ servers }) => {
    const res = await fetch(`${servers.http.url}/cookies`, {
      headers: { cookie: 'a=1; b=hello%20world' },
    });
    const json = (await res.json()) as { cookies: Record<string, string> };
    expect(json.cookies.a).toBe('1');
    expect(json.cookies.b).toBe('hello world');
  });
});

test.describe('HTTP — auth', () => {
  test('basic-auth challenges with WWW-Authenticate when missing credentials', async ({ servers }) => {
    const res = await fetch(`${servers.http.url}/basic-auth/alice/secret`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Basic realm');
  });

  test('basic-auth accepts correct credentials', async ({ servers }) => {
    const credentials = Buffer.from('alice:secret').toString('base64');
    const res = await fetch(`${servers.http.url}/basic-auth/alice/secret`, {
      headers: { authorization: `Basic ${credentials}` },
    });
    expect(res.ok).toBe(true);
    const json = (await res.json()) as { authenticated: boolean; user: string };
    expect(json.authenticated).toBe(true);
    expect(json.user).toBe('alice');
  });

  test('basic-auth rejects wrong credentials', async ({ servers }) => {
    const credentials = Buffer.from('alice:wrong').toString('base64');
    const res = await fetch(`${servers.http.url}/basic-auth/alice/secret`, {
      headers: { authorization: `Basic ${credentials}` },
    });
    expect(res.status).toBe(401);
  });

  test('bearer challenges then accepts a token', async ({ servers }) => {
    const r1 = await fetch(`${servers.http.url}/bearer`);
    expect(r1.status).toBe(401);
    expect(r1.headers.get('www-authenticate')).toContain('Bearer');

    const r2 = await fetch(`${servers.http.url}/bearer`, {
      headers: { authorization: 'Bearer my-token' },
    });
    expect(r2.ok).toBe(true);
    const json = (await r2.json()) as { token: string };
    expect(json.token).toBe('my-token');
  });
});

test.describe('HTTP — encoding & body', () => {
  test('gzip decodes transparently (fetch handles content-encoding)', async ({ servers }) => {
    const res = await fetch(`${servers.http.url}/gzip`);
    expect(res.headers.get('content-encoding')).toBe('gzip');
    const json = (await res.json()) as { gzipped: boolean };
    expect(json.gzipped).toBe(true);
  });

  test('large response /bytes/N delivers exact byte count', async ({ servers }) => {
    const size = 64 * 1024;
    const res = await fetch(`${servers.http.url}/bytes/${size}`);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-length')).toBe(String(size));
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.byteLength).toBe(size);
    expect(body.every((b) => b === 0x61)).toBe(true);
  });

  test('chunked transfer encoding streams 3 parts', async ({ servers }) => {
    const res = await fetch(`${servers.http.url}/chunked`);
    const text = await res.text();
    expect(text.split('\n').filter(Boolean)).toEqual(['chunk-1', 'chunk-2', 'chunk-3']);
  });
});

test.describe('HTTP — multipart upload', () => {
  test('parses multipart/form-data with file + scalar fields', async ({ servers }) => {
    const form = new FormData();
    form.set('username', 'ada');
    form.set('avatar', new Blob([new TextEncoder().encode('PNG-BYTES')], { type: 'image/png' }), 'avatar.png');

    const res = await fetch(`${servers.http.url}/upload`, { method: 'POST', body: form });
    expect(res.ok).toBe(true);
    const json = (await res.json()) as {
      fields: Array<{ name: string; filename?: string; size: number; preview: string }>;
    };
    expect(json.fields.length).toBe(2);
    const username = json.fields.find((f) => f.name === 'username');
    const avatar = json.fields.find((f) => f.name === 'avatar');
    expect(username?.preview).toBe('ada');
    expect(avatar?.filename).toBe('avatar.png');
    expect(avatar?.preview).toBe('PNG-BYTES');
  });
});

test.describe('HTTP — redirects', () => {
  test('redirect-to follows to the target URL', async ({ servers }) => {
    const res = await fetch(
      `${servers.http.url}/redirect-to?url=${encodeURIComponent(`${servers.http.url}/json`)}`,
      { redirect: 'follow' }
    );
    expect(res.ok).toBe(true);
    const json = (await res.json()) as { hello: string };
    expect(json.hello).toBe('world');
  });

  test('redirect chain /redirect/3 hops three times then returns done', async ({ servers }) => {
    const res = await fetch(`${servers.http.url}/redirect/3`, { redirect: 'follow' });
    expect(res.ok).toBe(true);
    const json = (await res.json()) as { done: boolean };
    expect(json.done).toBe(true);
  });

  test('manual mode returns the 302 with location header', async ({ servers }) => {
    const res = await fetch(`${servers.http.url}/redirect/2`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/redirect/1');
  });
});

test.describe('HTTP — rate limiting', () => {
  test('429 response carries Retry-After header', async ({ servers }) => {
    const res = await fetch(`${servers.http.url}/rate-limit`);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('2');
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('rate_limited');
  });
});
