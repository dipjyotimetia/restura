import { describe, expect, it, vi } from 'vitest';
import { SECRET_HANDLE_PLACEHOLDER } from '../secrets/secret-ref';
import {
  exchangeCodeForToken,
  fetchClientCredentialsToken,
  fetchDeviceCode,
  fetchPasswordToken,
  fetchRefreshToken,
  OAuth2TokenError,
} from './oauth2';

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

describe('masked secret placeholder never reaches a token endpoint', () => {
  const ok = () => respond(JSON.stringify({ access_token: 'at' }));

  it('refuses a masked client secret before sending', async () => {
    const fetch = ok();
    const error = await fetchClientCredentialsToken(
      { ...config, clientSecret: SECRET_HANDLE_PLACEHOLDER },
      { fetch }
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(OAuth2TokenError);
    expect((error as OAuth2TokenError).errorCode).toBe('secret_unavailable');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a masked refresh token before sending', async () => {
    const fetch = ok();
    await expect(
      fetchRefreshToken({
        clientId: 'c',
        tokenUrl: config.tokenUrl,
        refreshToken: SECRET_HANDLE_PLACEHOLDER,
        fetch,
      })
    ).rejects.toMatchObject({ errorCode: 'secret_unavailable' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a masked password before sending', async () => {
    const fetch = ok();
    await expect(
      fetchPasswordToken(
        { ...config, grantType: 'password', username: 'u', password: SECRET_HANDLE_PLACEHOLDER },
        { fetch }
      )
    ).rejects.toMatchObject({ errorCode: 'secret_unavailable' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('injected token transport', () => {
  it('sends every grant through the injected fetch, not the global one', async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal('fetch', globalFetch);
    try {
      const fetch = respond(JSON.stringify({ access_token: 'at' }));
      await fetchPasswordToken(
        { ...config, grantType: 'password', username: 'u', password: 'p' },
        { fetch }
      );
      await exchangeCodeForToken({ ...config, redirectUri: 'https://app/cb' }, 'code', 'v', {
        fetch,
      });
      await fetchRefreshToken({
        clientId: 'c',
        tokenUrl: config.tokenUrl,
        refreshToken: 'r',
        fetch,
      });
      const deviceFetch = respond(
        JSON.stringify({ device_code: 'd', user_code: 'u', verification_uri: 'v', expires_in: 5 })
      );
      await fetchDeviceCode(
        { ...config, grantType: 'device_code', deviceAuthorizationUrl: 'https://idp/device' },
        { fetch: deviceFetch }
      );
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(deviceFetch).toHaveBeenCalledTimes(1);
      expect(globalFetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
