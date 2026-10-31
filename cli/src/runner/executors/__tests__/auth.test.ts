import { describe, expect, it } from 'vitest';
import { applyAuthHeaders, resolveOAuth2Token, secretString, toProtocolAuth } from '../auth';

describe('a secret the CLI cannot read fails explicitly', () => {
  const external = {
    kind: 'external' as const,
    provider: 'aws-secrets-manager' as const,
    profileId: 'p',
    secretId: 'prod/token',
  };
  const send = (auth: Parameters<typeof applyAuthHeaders>[0]) => applyAuthHeaders(auth, {}, {});

  it('reads plain and inline values, and passes an absent one through', () => {
    expect(secretString('s')).toBe('s');
    expect(secretString({ kind: 'inline', value: 's' })).toBe('s');
    expect(secretString(undefined)).toBeUndefined();
  });

  it('refuses an unresolved external ref in every header scheme', () => {
    for (const auth of [
      { type: 'bearer', bearer: { token: external } },
      { type: 'basic', basic: { username: 'u', password: external } },
      { type: 'api-key', apiKey: { key: 'k', value: external, in: 'header' } },
      { type: 'oauth2', oauth2: { accessToken: external } },
    ] as const) {
      expect(() => send(auth)).toThrow('external secret reference');
    }
  });

  it('refuses rather than signing a wire scheme with an empty secret', () => {
    expect(() =>
      toProtocolAuth({ type: 'digest', digest: { username: 'a', password: external } })
    ).toThrow('external secret reference');
  });

  it('refuses before an OAuth2 token request can go out', async () => {
    await expect(
      resolveOAuth2Token({ type: 'oauth2', oauth2: { accessToken: external } }, {})
    ).rejects.toThrow('external secret reference');
  });

  it('refuses a secret object of an unknown shape', () => {
    expect(() => secretString({ kind: 'mystery' })).toThrow('unrecognised secret value');
    expect(() => secretString({ value: 'x' })).toThrow('unrecognised secret value');
  });

  it('names no secret identifier in the error', () => {
    expect(() => secretString(external)).not.toThrow('prod/token');
  });
});

describe('Digest auth in the CLI', () => {
  const auth = {
    type: 'digest' as const,
    digest: { username: 'alice', password: { kind: 'inline' as const, value: 's3cret' } },
  };

  it('forwards digest to the shared proxy as a wire-answered scheme', () => {
    expect(toProtocolAuth(auth)).toEqual({
      type: 'digest',
      digest: { username: 'alice', password: 's3cret' },
    });
  });

  it('adds no pre-emptive Authorization header (credentials wait for the challenge)', () => {
    const headers: Record<string, string> = {};
    const params: Record<string, string> = {};
    applyAuthHeaders(auth, headers, params);
    expect(headers).toEqual({});
    expect(params).toEqual({});
  });

  it('refuses a desktop-only handle loudly', () => {
    expect(() =>
      toProtocolAuth({
        type: 'digest',
        digest: { username: 'a', password: { kind: 'handle', id: 'h' } },
      })
    ).toThrow();
  });
});
