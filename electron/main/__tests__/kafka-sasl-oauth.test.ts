import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', isPackaged: false },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
}));

import {
  createClientCredentialsTokenProvider,
  createGuardedTokenFetch,
  createRefreshingTokenProvider,
  type ExpiringToken,
  refreshLeadMs,
  TOKEN_REFRESH_SKEW_MS,
  TOKEN_RESPONSE_MAX_BYTES,
} from '../handlers/kafka/sasl-oauth';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createRefreshingTokenProvider', () => {
  it('refreshes once less than max(30s, 25% of the lifetime) remains (fake clock)', async () => {
    let now = 1_000_000;
    let issued = 0;
    const ttl = 300_000;
    const fetchToken = vi.fn(
      async (): Promise<ExpiringToken> => ({ value: `token-${++issued}`, expiresAt: now + ttl })
    );
    const provider = createRefreshingTokenProvider(fetchToken, () => now);

    expect(await provider()).toBe('token-1');
    now = 1_000_000 + 200_000;
    expect(await provider()).toBe('token-1');
    // 25% of 300s = 75s lead → refresh at 225s.
    now = 1_000_000 + ttl - refreshLeadMs(ttl) - 1;
    expect(await provider()).toBe('token-1');
    expect(fetchToken).toHaveBeenCalledTimes(1);
    now = 1_000_000 + ttl - refreshLeadMs(ttl);
    expect(await provider()).toBe('token-2');
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  it('library re-auth at 0.8 x lifetime gets a NEW token', async () => {
    for (const ttl of [60_000, 300_000, 3_600_000]) {
      let now = 0;
      let issued = 0;
      const provider = createRefreshingTokenProvider(
        async () => ({ value: `t${++issued}`, expiresAt: now + ttl }),
        () => now
      );
      expect(await provider()).toBe('t1');
      // @platformatic/kafka re-authenticates at reauthFraction (0.8) of the session lifetime.
      now = 0.8 * ttl;
      expect(await provider()).toBe('t2');
    }
  });

  it('never refreshes later than 30s before expiry for short-lived tokens', () => {
    expect(refreshLeadMs(60_000)).toBe(TOKEN_REFRESH_SKEW_MS);
    expect(refreshLeadMs(1_000)).toBe(TOKEN_REFRESH_SKEW_MS);
    expect(refreshLeadMs(400_000)).toBe(100_000);
  });

  it('single-flights concurrent callers (one token request for a broker fan-out)', async () => {
    let resolveFetch!: (token: ExpiringToken) => void;
    const fetchToken = vi.fn(
      () =>
        new Promise<ExpiringToken>((resolve) => {
          resolveFetch = resolve;
        })
    );
    const provider = createRefreshingTokenProvider(fetchToken, () => 0);
    const calls = [provider(), provider(), provider()];
    resolveFetch({ value: 'shared', expiresAt: 600_000 });
    expect(await Promise.all(calls)).toEqual(['shared', 'shared', 'shared']);
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });

  it('does not cache failures — the next call retries', async () => {
    const fetchToken = vi
      .fn<() => Promise<ExpiringToken>>()
      .mockRejectedValueOnce(new Error('idp down'))
      .mockResolvedValueOnce({ value: 'recovered', expiresAt: 600_000 });
    const provider = createRefreshingTokenProvider(fetchToken, () => 0);
    await expect(provider()).rejects.toThrow('idp down');
    expect(await provider()).toBe('recovered');
  });

  it('refreshes on the library re-auth path driven by vi fake timers', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-18T00:00:00Z'));
      const tokens: string[] = [];
      const fetchToken = vi.fn(async () => ({
        value: `t${fetchToken.mock.calls.length}`,
        expiresAt: Date.now() + 120_000,
      }));
      const provider = createRefreshingTokenProvider(fetchToken);
      // Simulate @platformatic/kafka re-authenticating (KIP-368) every 50s:
      // each reauth calls the token provider again.
      for (let i = 0; i < 4; i += 1) {
        tokens.push(await provider());
        vi.advanceTimersByTime(50_000);
      }
      // t=0 → fetch, t=50 → cached, t=100 (>= 120-30) → refresh, t=150 → cached.
      expect(tokens).toEqual(['t1', 't1', 't2', 't2']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createClientCredentialsTokenProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts the client-credentials grant through the guarded fetch and honours expires_in', async () => {
    let now = 5_000;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ access_token: 'abc', token_type: 'Bearer', expires_in: 60 })
    );
    const guardedFetch = vi.fn(async () => fetchImpl as unknown as typeof fetch);
    const resolveSecret = vi.fn(async () => 'shh');

    const provider = createClientCredentialsTokenProvider(
      {
        tokenEndpoint: 'https://idp.example.com/oauth2/token',
        clientId: 'kafka-client',
        clientSecret: { kind: 'handle', id: '00000000-0000-4000-8000-000000000001' },
        scope: 'kafka',
      },
      { guardedFetch, resolveSecret, now: () => now }
    );

    expect(await provider()).toBe('abc');
    expect(guardedFetch).toHaveBeenCalledWith('https://idp.example.com/oauth2/token');
    expect(resolveSecret).toHaveBeenCalledWith({
      kind: 'handle',
      id: '00000000-0000-4000-8000-000000000001',
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://idp.example.com/oauth2/token');
    expect(init?.method).toBe('POST');
    const body = new URLSearchParams(String(init?.body));
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('client_id')).toBe('kafka-client');
    expect(body.get('client_secret')).toBe('shh');
    expect(body.get('scope')).toBe('kafka');

    // Cached until 60s - 30s skew.
    now += 29_000;
    expect(await provider()).toBe('abc');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 1_000;
    await provider();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('falls back to the JWT exp claim when expires_in is absent', async () => {
    const exp = 2_000; // seconds
    const jwt = [
      Buffer.from('{"alg":"none"}').toString('base64url'),
      Buffer.from(JSON.stringify({ exp })).toString('base64url'),
      'sig',
    ].join('.');
    let now = 1_000_000; // ms → 1000s
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: jwt }));
    const provider = createClientCredentialsTokenProvider(
      {
        tokenEndpoint: 'https://idp.example.com/token',
        clientId: 'c',
        clientSecret: 's',
      },
      {
        guardedFetch: async () => fetchImpl as unknown as typeof fetch,
        resolveSecret: async (v) => (typeof v === 'string' ? v : undefined),
        now: () => now,
      }
    );
    await provider();
    // Lifetime 1000s → lead 250s.
    now = exp * 1000 - refreshLeadMs(1_000_000) - 1;
    await provider();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = exp * 1000 - refreshLeadMs(1_000_000);
    await provider();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('fails clearly when the secret handle cannot be resolved', async () => {
    const guardedFetch = vi.fn();
    const provider = createClientCredentialsTokenProvider(
      {
        tokenEndpoint: 'https://idp.example.com/token',
        clientId: 'c',
        clientSecret: { kind: 'handle', id: 'missing' },
      },
      { guardedFetch, resolveSecret: async () => undefined, now: () => 0 }
    );
    await expect(provider()).rejects.toThrow(/client secret.*could not be resolved/i);
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it('surfaces RFC 6749 errors and rejects responses without an access_token', async () => {
    const deps = (body: unknown, status = 200) => ({
      guardedFetch: async () => (async () => jsonResponse(body, status)) as unknown as typeof fetch,
      resolveSecret: async () => 's',
      now: () => 0,
    });
    const cfg = {
      tokenEndpoint: 'https://idp.example.com/token',
      clientId: 'c',
      clientSecret: 's',
    };
    await expect(
      createClientCredentialsTokenProvider(
        cfg,
        deps({ error: 'invalid_client', error_description: 'bad secret' }, 401)
      )()
    ).rejects.toThrow('bad secret');
    await expect(
      createClientCredentialsTokenProvider(cfg, deps({ token_type: 'Bearer' }))()
    ).rejects.toThrow(/access_token/);
  });

  it('routes the token endpoint through the SSRF guard by default — private IPs are rejected under the default policy', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const provider = createClientCredentialsTokenProvider(
      {
        tokenEndpoint: 'http://10.0.0.5/oauth/token',
        clientId: 'c',
        clientSecret: 's',
      },
      { resolveSecret: async () => 's' }
    );
    await expect(provider()).rejects.toThrow(/token endpoint rejected/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('token request hygiene', () => {
  const cfg = { tokenEndpoint: 'https://idp.example.com/token', clientId: 'c', clientSecret: 's' };

  it('closes the per-request connection pool after success and failure', async () => {
    for (const body of [{ access_token: 'ok', expires_in: 60 }, { error: 'invalid_client' }]) {
      const close = vi.fn(async () => {});
      const fetchImpl = Object.assign(
        vi.fn(async () => jsonResponse(body, 'error' in body ? 401 : 200)),
        { close }
      );
      await createClientCredentialsTokenProvider(cfg, {
        guardedFetch: async () => fetchImpl as unknown as typeof fetch,
        resolveSecret: async () => 's',
      })().catch(() => undefined);
      expect(close).toHaveBeenCalledTimes(1);
    }
  });

  it('aborts an oversized token response (1 MB cap)', async () => {
    const huge = new Response('x'.repeat(10), {
      headers: { 'content-length': String(TOKEN_RESPONSE_MAX_BYTES + 1) },
    });
    await expect(
      createClientCredentialsTokenProvider(cfg, {
        guardedFetch: async () => (async () => huge) as unknown as typeof fetch,
        resolveSecret: async () => 's',
      })()
    ).rejects.toThrow('Token response exceeded the size limit');
  });

  it('handles null / array token responses without crashing', async () => {
    for (const body of [null, []]) {
      await expect(
        createClientCredentialsTokenProvider(cfg, {
          guardedFetch: async () => (async () => jsonResponse(body)) as unknown as typeof fetch,
          resolveSecret: async () => 's',
        })()
      ).rejects.toThrow(/invalid response/);
    }
  });
});

describe('createGuardedTokenFetch', () => {
  it('rejects private, metadata and non-http endpoints before any network I/O', async () => {
    await expect(createGuardedTokenFetch('http://192.168.1.10/token')).rejects.toThrow(
      /token endpoint rejected/i
    );
    await expect(
      createGuardedTokenFetch('http://169.254.169.254/latest/meta-data/')
    ).rejects.toThrow(/token endpoint rejected/i);
    await expect(createGuardedTokenFetch('ftp://idp.example.com/token')).rejects.toThrow(
      /token endpoint rejected/i
    );
  });

  it('requires https except for loopback / private IP literal hosts', async () => {
    await expect(createGuardedTokenFetch('http://idp.example.com/token')).rejects.toThrow(
      /https is required/
    );
  });
});
