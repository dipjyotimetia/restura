/**
 * Digest auth (RFC 7616, issue #861) security regressions.
 *
 * Digest is answered by exactly one retry after a 401 challenge inside the
 * shared `executeHttpProxy`, so every backend (Worker, Node self-host,
 * Electron main, CLI) inherits these guarantees:
 *  - the first request carries no credentials in any form;
 *  - a 401 that isn't a Digest challenge is never retried;
 *  - a 401 reached through a redirect chain that left the origin (on ANY hop)
 *    is never answered, and the retry shares the redirect budget;
 *  - the password never appears on the wire, in the result, or in the console;
 *  - a desktop-only secret handle fails fast on the Worker.
 */
import { executeHttpProxy } from '@shared/protocol/http-proxy';
import { containsAuthHandle, ProtocolAuthConfigSchema } from '@shared/protocol/proxy-schema';
import type { Fetcher, FetcherRequest, FetcherResponse, RequestSpec } from '@shared/protocol/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

const USER = 'alice';
const PASSWORD = 'pa55-W0rd-s3cret';
const SECRET_FORMS = [
  PASSWORD,
  encodeURIComponent(PASSWORD),
  btoa(`${USER}:${PASSWORD}`),
  btoa(PASSWORD),
];

type Reply = Partial<FetcherResponse> & { status: number };
interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function scripted(...replies: Reply[]) {
  const calls: Seen[] = [];
  const fetcher: Fetcher = async (req: FetcherRequest) => {
    calls.push({
      url: req.url,
      method: req.method,
      headers: new Headers(req.headers),
      body: req.body,
    });
    const r = replies[Math.min(calls.length, replies.length) - 1]!;
    return {
      statusText: '',
      headers: {},
      text: async () => '',
      contentLengthHeader: null,
      ...r,
    };
  };
  return { fetcher, calls };
}

function serialise(seen: Seen): string {
  return JSON.stringify({
    url: seen.url,
    headers: [...seen.headers.entries()],
    body: typeof seen.body === 'string' ? seen.body : null,
  });
}

function expectNoSecret(text: string) {
  for (const form of SECRET_FORMS) expect(text).not.toContain(form);
}

const spec = (over: Partial<RequestSpec> = {}): RequestSpec => ({
  method: 'POST',
  url: 'https://api.example.com/private',
  bodyType: 'json',
  data: '{"q":1}',
  auth: { type: 'digest', digest: { username: USER, password: PASSWORD } },
  ...over,
});
const digest401: Reply = {
  status: 401,
  headers: { 'www-authenticate': 'Digest realm="r", nonce="n0nce", qop="auth"' },
};

afterEach(() => vi.restoreAllMocks());

describe('Digest auth — security', () => {
  it('first request carries no Authorization and no password in any form', async () => {
    const { fetcher, calls } = scripted(digest401, { status: 200 });
    await executeHttpProxy(spec(), fetcher, { allowLocalhost: false });
    expect(calls[0]!.headers.get('authorization')).toBeNull();
    expectNoSecret(serialise(calls[0]!));
  });

  it('the retry carries only the hash — never the password', async () => {
    const { fetcher, calls } = scripted(digest401, { status: 200 });
    await executeHttpProxy(spec(), fetcher, { allowLocalhost: false });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers.get('authorization')).toMatch(/^Digest /);
    expectNoSecret(serialise(calls[1]!));
  });

  it.each([
    ['a Basic challenge', { 'www-authenticate': 'Basic realm="r"' }],
    ['a Bearer challenge', { 'www-authenticate': 'Bearer error="invalid_token"' }],
    ['no challenge at all', {}],
    [
      'a Digest challenge with an unsupported algorithm',
      { 'www-authenticate': 'Digest realm="r", nonce="n", algorithm=SHA-512-256' },
    ],
  ])('does not retry on %s', async (_label, headers) => {
    const { fetcher, calls } = scripted({ status: 401, headers }, { status: 200 });
    const r = await executeHttpProxy(spec(), fetcher, { allowLocalhost: false });
    expect(calls).toHaveLength(1);
    expect(r.ok && r.response.status).toBe(401);
  });

  it('does not retry on a non-401 status even with a Digest challenge header', async () => {
    const { fetcher, calls } = scripted({ ...digest401, status: 403 });
    await executeHttpProxy(spec(), fetcher, { allowLocalhost: false });
    expect(calls).toHaveLength(1);
  });

  it('never answers a Digest challenge reached through a cross-origin redirect', async () => {
    const { fetcher, calls } = scripted(
      { status: 307, headers: { location: 'https://evil.example.net/steal' } },
      digest401,
      { status: 200 }
    );
    const r = await executeHttpProxy(spec(), fetcher, { allowLocalhost: false });
    expect(calls).toHaveLength(2);
    expect(r.ok && r.response.status).toBe(401);
    for (const c of calls) expect(c.headers.get('authorization')).toBeNull();
  });

  it('never answers a Digest challenge when ANY hop left the origin (A → evil → A)', async () => {
    const { fetcher, calls } = scripted(
      { status: 307, headers: { location: 'https://evil.example.net/bounce' } },
      { status: 307, headers: { location: 'https://api.example.com/private' } },
      digest401,
      { status: 200 }
    );
    const r = await executeHttpProxy(spec(), fetcher, { allowLocalhost: false });
    expect(calls).toHaveLength(3);
    expect(r.ok && r.response.status).toBe(401);
    for (const c of calls) expect(c.headers.get('authorization')).toBeNull();
  });

  it('shares one redirect budget across the challenge and the retry', async () => {
    const same = (path: string): Reply => ({ status: 307, headers: { location: path } });
    const { fetcher, calls } = scripted(same('/a'), same('/b'), digest401, same('/c'), {
      status: 200,
    });
    const r = await executeHttpProxy(spec({ redirectPolicy: { maxRedirects: 2 } }), fetcher, {
      allowLocalhost: false,
    });
    // 2 hops before the challenge exhaust the budget: the retry's redirect is refused.
    expect(calls).toHaveLength(4);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.payload.error).toMatch(/Too many redirects/);
  });

  it('answers a Digest challenge after a same-origin redirect with the final request-target', async () => {
    const { fetcher, calls } = scripted(
      { status: 307, headers: { location: '/moved?x=1' } },
      digest401,
      { status: 200 }
    );
    await executeHttpProxy(spec(), fetcher, { allowLocalhost: false });
    expect(calls).toHaveLength(3);
    expect(calls[2]!.url).toBe('https://api.example.com/moved?x=1');
    expect(calls[2]!.headers.get('authorization')).toContain('uri="/moved?x=1"');
  });

  it('keeps the password out of the result envelope and the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {})
    );
    const { fetcher } = scripted(digest401, { status: 200, text: async () => 'ok' });
    const r = await executeHttpProxy(spec(), fetcher, { allowLocalhost: false });
    expectNoSecret(JSON.stringify(r));
    for (const spy of spies) expectNoSecret(JSON.stringify(spy.mock.calls));
  });

  it('the Worker rejects a desktop-only digest password handle up front', () => {
    const auth = ProtocolAuthConfigSchema.parse({
      type: 'digest',
      digest: { username: USER, password: { kind: 'handle', id: 'h1' } },
    });
    expect(auth.digest).toBeDefined();
    expect(containsAuthHandle(auth)).toBe(true);
  });
});
