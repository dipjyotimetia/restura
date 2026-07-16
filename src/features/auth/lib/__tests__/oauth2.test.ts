import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authorizeWithPopup,
  buildAuthorizationUrl,
  exchangeCodeForToken,
  fetchClientCredentialsToken,
  fetchRefreshToken,
  OAuth2TokenError,
  tokenExpiresAt,
} from '../oauth2';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const mockTokenResponse = {
  access_token: 'next-token',
  token_type: 'Bearer',
  expires_in: 3600,
  refresh_token: 'refresh-next',
};

const baseConfig = {
  grantType: 'authorization_code' as const,
  clientId: 'client',
  authorizationUrl: 'https://auth.example/authorize',
  tokenUrl: 'https://auth.example/token',
  redirectUri: 'https://app.example/callback',
  scope: 'read write',
};

describe('authorizeWithPopup', () => {
  it('returns null when the browser blocks the popup', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);

    await expect(authorizeWithPopup('https://auth.example', 'expected')).resolves.toBeNull();
  });

  it('returns the authorization code and closes a matching popup', async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    vi.spyOn(window, 'open').mockReturnValue({
      closed: false,
      close,
      location: { href: 'https://app.example/callback?code=code-1&state=expected' },
    } as unknown as Window);

    const result = authorizeWithPopup('https://auth.example', 'expected');
    await vi.advanceTimersByTimeAsync(500);

    await expect(result).resolves.toEqual({ code: 'code-1' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('returns null when the user closes the popup', async () => {
    vi.useFakeTimers();
    vi.spyOn(window, 'open').mockReturnValue({ closed: true } as Window);

    const result = authorizeWithPopup('https://auth.example', 'expected');
    await vi.advanceTimersByTimeAsync(500);

    await expect(result).resolves.toBeNull();
  });

  it('tolerates cross-origin access and times out safely', async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    const popup = { closed: false, close } as {
      closed: boolean;
      close: () => void;
      location?: Location;
    };
    Object.defineProperty(popup, 'location', {
      get: () => {
        throw new DOMException('Blocked by same-origin policy', 'SecurityError');
      },
    });
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);

    const result = authorizeWithPopup('https://auth.example', 'expected', 400);
    await vi.advanceTimersByTimeAsync(500);

    await expect(result).resolves.toBeNull();
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('buildAuthorizationUrl', () => {
  it('builds authorization URL with PKCE challenge and state', async () => {
    const result = await buildAuthorizationUrl(baseConfig);

    const url = new URL(result.url);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example/callback');
    expect(url.searchParams.get('state')).toBe(result.state);
    expect(result.codeVerifier.length).toBeGreaterThan(30);
  });

  it('throws when authorizationUrl is missing', async () => {
    await expect(
      buildAuthorizationUrl({ ...baseConfig, authorizationUrl: undefined })
    ).rejects.toThrow('Authorization URL is required');
  });

  it('throws when redirectUri is missing', async () => {
    await expect(buildAuthorizationUrl({ ...baseConfig, redirectUri: undefined })).rejects.toThrow(
      'Redirect URI is required'
    );
  });

  it('includes scope when provided', async () => {
    const result = await buildAuthorizationUrl({ ...baseConfig, scope: 'openid profile' });
    const url = new URL(result.url);
    expect(url.searchParams.get('scope')).toBe('openid profile');
  });

  it('omits scope when it is not configured', async () => {
    const result = await buildAuthorizationUrl({ ...baseConfig, scope: undefined });

    expect(new URL(result.url).searchParams.has('scope')).toBe(false);
  });
});

describe('exchangeCodeForToken', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(mockTokenResponse), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
      )
    );
  });

  it('sends code_verifier in exchange request', async () => {
    await exchangeCodeForToken(baseConfig, 'auth-code', 'my-verifier');

    const body = String((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body);
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code=auth-code');
    expect(body).toContain('code_verifier=my-verifier');
  });

  it('includes the optional client secret in the exchange', async () => {
    await exchangeCodeForToken({ ...baseConfig, clientSecret: 'secret' }, 'code', 'verifier');

    const body = String((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body);
    expect(body).toContain('client_secret=secret');
  });

  it('throws when redirectUri is missing', async () => {
    await expect(
      exchangeCodeForToken({ ...baseConfig, redirectUri: undefined }, 'code', 'verifier')
    ).rejects.toThrow('Redirect URI is required');
  });
});

describe('fetchRefreshToken', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(mockTokenResponse), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
      )
    );
  });

  it('sends grant_type=refresh_token', async () => {
    await fetchRefreshToken({
      clientId: 'client',
      tokenUrl: 'https://auth.example/token',
      refreshToken: 'refresh-old',
    });

    const body = String((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body);
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=refresh-old');
    expect(body).toContain('client_id=client');
  });

  it('includes client_secret when provided', async () => {
    await fetchRefreshToken({
      clientId: 'client',
      tokenUrl: 'https://auth.example/token',
      refreshToken: 'refresh-old',
      clientSecret: 'secret',
    });

    const body = String((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body);
    expect(body).toContain('client_secret=secret');
  });

  it('includes scope and forwards an abort signal', async () => {
    const signal = new AbortController().signal;
    await fetchRefreshToken(
      {
        clientId: 'client',
        tokenUrl: 'https://auth.example/token',
        refreshToken: 'refresh-old',
        scope: 'read write',
      },
      signal
    );

    const init = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(String(init?.body)).toContain('scope=read+write');
    expect(init?.signal).toBe(signal);
  });

  it('returns token response on success', async () => {
    const result = await fetchRefreshToken({
      clientId: 'client',
      tokenUrl: 'https://auth.example/token',
      refreshToken: 'refresh-old',
    });

    expect(result.access_token).toBe('next-token');
    expect(result.refresh_token).toBe('refresh-next');
  });
});

describe('fetchClientCredentialsToken', () => {
  it('throws OAuth2TokenError on error response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: 'invalid_client', error_description: 'Bad credentials' }),
            { status: 401, headers: { 'content-type': 'application/json' } }
          )
      )
    );

    await expect(
      fetchClientCredentialsToken({
        grantType: 'client_credentials',
        clientId: 'bad-client',
        tokenUrl: 'https://auth.example/token',
      })
    ).rejects.toThrow(OAuth2TokenError);
  });

  it('uses safe fallbacks for a malformed token error response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } })
      )
    );

    await expect(
      fetchClientCredentialsToken({
        grantType: 'client_credentials',
        clientId: 'client',
        tokenUrl: 'https://auth.example/token',
      })
    ).rejects.toMatchObject({
      errorCode: 'unknown_error',
      message: 'Token request failed: 503',
    });
  });

  it('rejects an OAuth error body even when the HTTP status is successful', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'invalid_scope' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
      )
    );

    await expect(
      fetchClientCredentialsToken({
        grantType: 'client_credentials',
        clientId: 'client',
        tokenUrl: 'https://auth.example/token',
      })
    ).rejects.toMatchObject({ errorCode: 'invalid_scope' });
  });

  it('uses an injected fetch implementation when supplied by a secure caller', async () => {
    const secureFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(mockTokenResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );

    await fetchClientCredentialsToken(
      {
        grantType: 'client_credentials',
        clientId: 'client',
        tokenUrl: 'https://auth.example/token',
      },
      { fetch: secureFetch }
    );

    expect(secureFetch).toHaveBeenCalledWith(
      'https://auth.example/token',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('includes optional client credentials fields and forwards an abort signal', async () => {
    const signal = new AbortController().signal;
    const secureFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(mockTokenResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );

    await fetchClientCredentialsToken(
      {
        grantType: 'client_credentials',
        clientId: 'client',
        clientSecret: 'secret',
        scope: 'read write',
        tokenUrl: 'https://auth.example/token',
      },
      { fetch: secureFetch, signal }
    );

    const init = secureFetch.mock.calls[0]?.[1];
    expect(String(init?.body)).toContain('client_secret=secret');
    expect(String(init?.body)).toContain('scope=read+write');
    expect(init?.signal).toBe(signal);
  });
});

describe('fetchPasswordToken', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(mockTokenResponse), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
      )
    );
  });

  it('throws when username is missing', async () => {
    const { fetchPasswordToken } = await import('../oauth2');
    await expect(
      fetchPasswordToken({
        grantType: 'password',
        clientId: 'client',
        tokenUrl: 'https://auth.example/token',
        username: '',
        password: 'pass',
      })
    ).rejects.toThrow('Username and password are required');
  });

  it('sends grant_type=password with credentials', async () => {
    const { fetchPasswordToken } = await import('../oauth2');
    await fetchPasswordToken({
      grantType: 'password',
      clientId: 'client',
      tokenUrl: 'https://auth.example/token',
      username: 'user',
      password: 'pass',
    });

    const body = String((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body);
    expect(body).toContain('grant_type=password');
    expect(body).toContain('username=user');
    expect(body).toContain('password=pass');
  });

  it('includes optional password-grant client secret and scope', async () => {
    const { fetchPasswordToken } = await import('../oauth2');
    await fetchPasswordToken({
      grantType: 'password',
      clientId: 'client',
      clientSecret: 'secret',
      scope: 'read write',
      tokenUrl: 'https://auth.example/token',
      username: 'user',
      password: 'pass',
    });

    const body = String((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body);
    expect(body).toContain('client_secret=secret');
    expect(body).toContain('scope=read+write');
  });
});

describe('fetchDeviceCode', () => {
  it('throws when deviceAuthorizationUrl is missing', async () => {
    const { fetchDeviceCode } = await import('../oauth2');
    await expect(
      fetchDeviceCode({
        grantType: 'device_code',
        clientId: 'client',
        tokenUrl: 'https://auth.example/token',
      })
    ).rejects.toThrow('Device Authorization URL is required');
  });

  it('sends device code request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              device_code: 'device-abc',
              user_code: 'ABCD-1234',
              verification_uri: 'https://device.example/activate',
              expires_in: 300,
              interval: 5,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
      )
    );

    const { fetchDeviceCode } = await import('../oauth2');
    const result = await fetchDeviceCode({
      grantType: 'device_code',
      clientId: 'client',
      tokenUrl: 'https://auth.example/token',
      deviceAuthorizationUrl: 'https://auth.example/device_authorization',
    });

    expect(result.device_code).toBe('device-abc');
    expect(result.user_code).toBe('ABCD-1234');
  });

  it('includes scope in the device authorization request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              device_code: 'device-abc',
              user_code: 'ABCD-1234',
              verification_uri: 'https://device.example/activate',
              expires_in: 300,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
      )
    );

    const { fetchDeviceCode } = await import('../oauth2');
    await fetchDeviceCode({
      grantType: 'device_code',
      clientId: 'client',
      scope: 'read write',
      tokenUrl: 'https://auth.example/token',
      deviceAuthorizationUrl: 'https://auth.example/device_authorization',
    });

    const body = String((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body);
    expect(body).toContain('scope=read+write');
  });

  it('throws on non-ok response from device endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{}', { status: 400, headers: { 'content-type': 'application/json' } })
      )
    );

    const { fetchDeviceCode } = await import('../oauth2');
    await expect(
      fetchDeviceCode({
        grantType: 'device_code',
        clientId: 'client',
        tokenUrl: 'https://auth.example/token',
        deviceAuthorizationUrl: 'https://auth.example/device_authorization',
      })
    ).rejects.toThrow('Device code request failed');
  });
});

describe('pollForDeviceToken', () => {
  it('throws timed out when max attempts reached with 0s interval', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'authorization_pending' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          })
      )
    );

    const { pollForDeviceToken } = await import('../oauth2');
    await expect(
      pollForDeviceToken(
        { grantType: 'device_code', clientId: 'client', tokenUrl: 'https://auth.example/token' },
        'device-code-abc',
        0, // 0 second interval avoids slow real timers
        1 // only 1 attempt
      )
    ).rejects.toThrow('timed out');
  });

  it('terminates on non-pending errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'access_denied' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          })
      )
    );

    const { pollForDeviceToken } = await import('../oauth2');
    await expect(
      pollForDeviceToken(
        { grantType: 'device_code', clientId: 'client', tokenUrl: 'https://auth.example/token' },
        'device-code-abc',
        0,
        3
      )
    ).rejects.toThrow();
  });
});

describe('tokenExpiresAt', () => {
  it('computes expiry timestamp from now + seconds', () => {
    const now = 1_000_000;
    expect(tokenExpiresAt(now, 3600)).toBe(now + 3_600_000);
  });

  it('returns undefined when expiresInSeconds is falsy', () => {
    expect(tokenExpiresAt(Date.now(), undefined)).toBeUndefined();
    expect(tokenExpiresAt(Date.now(), 0)).toBeUndefined();
  });
});
