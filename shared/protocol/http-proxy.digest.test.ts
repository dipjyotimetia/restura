import { describe, expect, it } from 'vitest';
import { md5Hex } from './crypto-utils';
import { executeHttpProxy, executeHttpProxyStreaming } from './http-proxy';
import type { Fetcher, FetcherRequest, FetcherResponse, RequestSpec } from './types';

type Reply = Partial<FetcherResponse> & { status: number };

/** Scripted fetcher: answers each call with the next reply and records the request. */
function scripted(...replies: Reply[]) {
  const calls: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];
  const fetcher: Fetcher = async (req: FetcherRequest) => {
    calls.push({
      url: req.url,
      method: req.method,
      headers: new Headers(req.headers),
      body: req.body,
    });
    const r = replies[calls.length - 1] ?? replies[replies.length - 1]!;
    return {
      statusText: '',
      headers: {},
      text: async () => '',
      contentLengthHeader: null,
      body: new ReadableStream<Uint8Array>(),
      ...r,
    };
  };
  return { fetcher, calls };
}

function authParams(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of (header ?? '').slice(7).matchAll(/([a-z]+)=(?:"([^"]*)"|([^,\s]+))/gi)) {
    out[m[1]!] = m[2] ?? m[3]!;
  }
  return out;
}

const digestAuth = {
  type: 'digest' as const,
  digest: { username: 'Mufasa', password: 'Circle of Life' },
};
const challenge401: Reply = {
  status: 401,
  headers: { 'www-authenticate': 'Digest realm="r", nonce="abc", qop="auth", algorithm=MD5' },
};

function spec(over: Partial<RequestSpec> = {}): RequestSpec {
  return {
    method: 'GET',
    url: 'https://api.example.com/dir/index.html?a=1',
    auth: digestAuth,
    ...over,
  };
}

describe('executeHttpProxy — Digest challenge/retry', () => {
  it('sends no credentials first, then retries once with a valid Digest Authorization', async () => {
    const { fetcher, calls } = scripted(challenge401, { status: 200, text: async () => 'ok' });
    const r = await executeHttpProxy(spec(), fetcher, { allowLocalhost: false });

    expect(r.ok && r.response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers.get('authorization')).toBeNull();

    const p = authParams(calls[1]!.headers.get('authorization'));
    // uri is the request-target actually sent: path + query.
    expect(p.uri).toBe('/dir/index.html?a=1');
    expect(p.username).toBe('Mufasa');
    const ha1 = md5Hex('Mufasa:r:Circle of Life');
    const ha2 = md5Hex('GET:/dir/index.html?a=1');
    expect(p.response).toBe(md5Hex(`${ha1}:abc:00000001:${p.cnonce}:auth:${ha2}`));
  });

  it('retries exactly once even if the retry is also challenged', async () => {
    const { fetcher, calls } = scripted(challenge401, challenge401, { status: 200 });
    const r = await executeHttpProxy(spec(), fetcher, { allowLocalhost: false });
    expect(calls).toHaveLength(2);
    expect(r.ok && r.response.status).toBe(401);
  });

  it('replays the same body and method on the retry', async () => {
    const { fetcher, calls } = scripted(challenge401, { status: 200 });
    await executeHttpProxy(spec({ method: 'POST', bodyType: 'json', data: '{"x":1}' }), fetcher, {
      allowLocalhost: false,
    });
    expect(calls[1]!.method).toBe('POST');
    expect(calls[1]!.body).toBe('{"x":1}');
    expect(calls[1]!.headers.get('content-type')).toBe('application/json');
    expect(authParams(calls[1]!.headers.get('authorization')).uri).toBe('/dir/index.html?a=1');
  });

  it('replays a custom extension method verbatim and hashes it case-preserved (#857)', async () => {
    const { fetcher, calls } = scripted(challenge401, { status: 200 });
    const r = await executeHttpProxy(spec({ method: 'Purge' }), fetcher, {
      allowLocalhost: false,
    });
    expect(r.ok && r.response.status).toBe(200);
    expect(calls.map((c) => c.method)).toEqual(['Purge', 'Purge']);
    const p = authParams(calls[1]!.headers.get('authorization'));
    const ha1 = md5Hex('Mufasa:r:Circle of Life');
    const ha2 = md5Hex('Purge:/dir/index.html?a=1');
    expect(p.response).toBe(md5Hex(`${ha1}:abc:00000001:${p.cnonce}:auth:${ha2}`));
  });

  it('surfaces setCookies and bodyNotice from the post-challenge response, not the 401', async () => {
    const { fetcher } = scripted(
      {
        ...challenge401,
        headers: { ...challenge401.headers, 'set-cookie': ['challenge=1; Path=/'] },
        bodyNotice: 'from-401',
      },
      {
        status: 200,
        headers: { 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'] },
        bodyNotice: 'from-200',
        text: async () => 'ok',
      }
    );
    const r = await executeHttpProxy(spec(), fetcher, { allowLocalhost: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.response.status).toBe(200);
    expect(r.response.setCookies).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    expect(r.response.bodyNotice).toBe('from-200');
  });

  it('rebuilds a multipart body for the retry', async () => {
    const { fetcher, calls } = scripted(challenge401, { status: 200 });
    await executeHttpProxy(
      spec({ method: 'POST', bodyType: 'form-data', formData: [{ name: 'f', value: 'v' }] }),
      fetcher,
      { allowLocalhost: false }
    );
    const retryBody = calls[1]!.body as FormData;
    expect(retryBody).toBeInstanceOf(FormData);
    expect(retryBody.get('f')).toBe('v');
    expect(retryBody).not.toBe(calls[0]!.body);
  });

  it('uses the raw request-target when encodeUrl is false', async () => {
    const { fetcher, calls } = scripted(challenge401, { status: 200 });
    await executeHttpProxy(
      spec({ url: 'https://api.example.com/a b?q=x y', encodeUrl: false }),
      fetcher,
      { allowLocalhost: false }
    );
    expect(authParams(calls[1]!.headers.get('authorization')).uri).toBe('/a b?q=x y');
  });

  it('accepts the challenge as a header array (Electron undici shape)', async () => {
    const { fetcher, calls } = scripted(
      {
        status: 401,
        headers: {
          'WWW-Authenticate': [
            'Basic realm="b"',
            'Digest realm="r", nonce="n", algorithm=SHA-256, qop="auth"',
          ],
        },
      },
      { status: 200 }
    );
    await executeHttpProxy(spec(), fetcher, { allowLocalhost: false });
    expect(authParams(calls[1]!.headers.get('authorization')).algorithm).toBe('SHA-256');
  });

  it('resolves the password through the supplied SecretResolver (desktop handles)', async () => {
    const { fetcher, calls } = scripted(challenge401, { status: 200 });
    const handle = { kind: 'handle' as const, id: 'h1' };
    await executeHttpProxy(
      spec({ auth: { type: 'digest', digest: { username: 'Mufasa', password: handle } } }),
      fetcher,
      { allowLocalhost: false, resolveSecret: (v) => (v === handle ? 'Circle of Life' : '') }
    );
    const p = authParams(calls[1]!.headers.get('authorization'));
    const ha1 = md5Hex('Mufasa:r:Circle of Life');
    const ha2 = md5Hex('GET:/dir/index.html?a=1');
    expect(p.response).toBe(md5Hex(`${ha1}:abc:00000001:${p.cnonce}:auth:${ha2}`));
  });

  it('fails loudly (no request sent) for a handle without a resolver', async () => {
    const { fetcher, calls } = scripted(challenge401);
    const r = await executeHttpProxy(
      spec({
        auth: { type: 'digest', digest: { username: 'u', password: { kind: 'handle', id: 'h' } } },
      }),
      fetcher,
      { allowLocalhost: false }
    );
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('streaming variant performs the same retry', async () => {
    const { fetcher, calls } = scripted(challenge401, { status: 200 });
    const r = await executeHttpProxyStreaming(spec(), fetcher, { allowLocalhost: false });
    expect(r.ok && r.response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers.get('authorization')).toMatch(/^Digest /);
  });

  it('does nothing special for non-digest auth on a Digest 401', async () => {
    const { fetcher, calls } = scripted(challenge401);
    await executeHttpProxy(spec({ auth: { type: 'none' } }), fetcher, { allowLocalhost: false });
    expect(calls).toHaveLength(1);
  });
});
