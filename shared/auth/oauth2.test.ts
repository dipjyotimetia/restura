import { describe, expect, it, vi } from 'vitest';
import { fetchClientCredentialsToken, OAuth2TokenError } from './oauth2';

const config = {
  grantType: 'client_credentials' as const,
  clientId: 'c',
  clientSecret: 's',
  tokenUrl: 'https://idp.example.com/token',
};

function respond(body: BodyInit | null, init: ResponseInit = {}) {
  return vi.fn(async () => new Response(body, { status: 200, ...init })) as unknown as typeof fetch;
}

function streamOf(totalBytes: number, chunk = 64 * 1024): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunk, totalBytes - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size).fill(0x20));
    },
  });
}

describe('postToken response handling', () => {
  it('returns the token for a normal response with and without a size cap', async () => {
    const body = JSON.stringify({ access_token: 'abc', expires_in: 60 });
    await expect(
      fetchClientCredentialsToken(config, { fetch: respond(body) })
    ).resolves.toMatchObject({ access_token: 'abc' });
    await expect(
      fetchClientCredentialsToken(config, { fetch: respond(body), maxResponseBytes: 1024 })
    ).resolves.toMatchObject({ access_token: 'abc' });
  });

  it('aborts an oversized response announced by content-length', async () => {
    const error = await fetchClientCredentialsToken(config, {
      fetch: respond('x'.repeat(10), { headers: { 'content-length': String(2 * 1024 * 1024) } }),
      maxResponseBytes: 1024 * 1024,
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(OAuth2TokenError);
    expect((error as OAuth2TokenError).errorCode).toBe('response_too_large');
  });

  it('aborts a streamed response once it passes the cap', async () => {
    const stream = streamOf(4 * 1024 * 1024);
    const cancel = vi.spyOn(stream, 'getReader');
    await expect(
      fetchClientCredentialsToken(config, {
        fetch: respond(stream),
        maxResponseBytes: 1024 * 1024,
      })
    ).rejects.toThrow('Token response exceeded the size limit');
    expect(cancel).toHaveBeenCalled();
  });

  it('rejects null, array and primitive JSON bodies with a clear error', async () => {
    for (const body of ['null', '[]', '"token"', '42']) {
      for (const maxResponseBytes of [undefined, 1024]) {
        const error = await fetchClientCredentialsToken(config, {
          fetch: respond(body),
          ...(maxResponseBytes ? { maxResponseBytes } : {}),
        }).catch((err: unknown) => err);
        expect(error).toBeInstanceOf(OAuth2TokenError);
        expect((error as OAuth2TokenError).errorCode).toBe('invalid_response');
      }
    }
  });

  it('reports non-JSON bodies when capped', async () => {
    await expect(
      fetchClientCredentialsToken(config, {
        fetch: respond('<html>gateway</html>', { status: 502 }),
        maxResponseBytes: 1024,
      })
    ).rejects.toThrow(/non-JSON response \(502\)/);
  });

  it('still surfaces RFC 6749 error bodies', async () => {
    await expect(
      fetchClientCredentialsToken(config, {
        fetch: respond(JSON.stringify({ error: 'invalid_client', error_description: 'nope' }), {
          status: 401,
        }),
        maxResponseBytes: 1024,
      })
    ).rejects.toThrow('nope');
  });
});
