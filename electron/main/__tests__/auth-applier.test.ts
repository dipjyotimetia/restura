// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

// Isolate auth-applier from the secret-handle store (which pulls in electron +
// electron-store). The real `unwrapSecretValueMain` passes plain strings through
// and resolves inline SecretRefs to their value — mirror exactly that.
vi.mock('../secret-handle-store', () => ({
  unwrapSecretValueMain: (v: unknown): string | undefined => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object' && (v as { kind?: string }).kind === 'inline') {
      return (v as { value?: string }).value;
    }
    return undefined;
  },
}));

import { applyNonSignAtWireAuth } from '../auth-applier';

// The descriptor shapes are intentionally partial; the helper only reads the
// fields relevant to each `type`. Cast through the real parameter type.
const apply = (a: unknown) =>
  applyNonSignAtWireAuth(a as Parameters<typeof applyNonSignAtWireAuth>[0]);

describe('applyNonSignAtWireAuth', () => {
  it('returns empty creds for undefined and type:none', () => {
    expect(apply(undefined)).toEqual({ headers: {}, params: {} });
    expect(apply({ type: 'none' })).toEqual({ headers: {}, params: {} });
  });

  it('builds a Bearer header', () => {
    expect(apply({ type: 'bearer', bearer: { token: 'tok' } })).toEqual({
      headers: { Authorization: 'Bearer tok' },
      params: {},
    });
  });

  it('omits Bearer when the token is empty', () => {
    expect(apply({ type: 'bearer', bearer: { token: '' } })).toEqual({ headers: {}, params: {} });
  });

  it('base64-encodes Basic credentials', () => {
    const res = apply({ type: 'basic', basic: { username: 'user', password: 'pass' } });
    expect(res.headers.Authorization).toBe(`Basic ${Buffer.from('user:pass').toString('base64')}`);
  });

  it('still emits Basic with an empty password (username-only)', () => {
    const res = apply({ type: 'basic', basic: { username: 'user', password: '' } });
    expect(res.headers.Authorization).toBe(`Basic ${Buffer.from('user:').toString('base64')}`);
  });

  it('returns empty Basic when username is missing', () => {
    expect(apply({ type: 'basic', basic: { username: '', password: 'p' } })).toEqual({
      headers: {},
      params: {},
    });
  });

  it('places an api-key in the header by default', () => {
    expect(
      apply({ type: 'api-key', apiKey: { key: 'X-Api-Key', value: 'secret', in: 'header' } })
    ).toEqual({ headers: { 'X-Api-Key': 'secret' }, params: {} });
  });

  it('places an api-key in the query when in:query', () => {
    expect(
      apply({ type: 'api-key', apiKey: { key: 'api_key', value: 'secret', in: 'query' } })
    ).toEqual({ headers: {}, params: { api_key: 'secret' } });
  });

  it('returns empty api-key when value is missing', () => {
    expect(
      apply({ type: 'api-key', apiKey: { key: 'X-Api-Key', value: '', in: 'header' } })
    ).toEqual({ headers: {}, params: {} });
  });

  it('uses oauth2 tokenType, defaulting to Bearer', () => {
    expect(apply({ type: 'oauth2', oauth2: { accessToken: 'at' } })).toEqual({
      headers: { Authorization: 'Bearer at' },
      params: {},
    });
    expect(apply({ type: 'oauth2', oauth2: { accessToken: 'at', tokenType: 'DPoP' } })).toEqual({
      headers: { Authorization: 'DPoP at' },
      params: {},
    });
  });

  it('resolves inline SecretRef values', () => {
    expect(
      apply({ type: 'bearer', bearer: { token: { kind: 'inline', value: 'reftok' } } })
    ).toEqual({ headers: { Authorization: 'Bearer reftok' }, params: {} });
  });

  it('returns empty for sign-at-wire types (handled by executeHttpProxy)', () => {
    for (const type of ['aws-signature', 'oauth1', 'wsse', 'ntlm', 'digest'] as const) {
      expect(apply({ type })).toEqual({ headers: {}, params: {} });
    }
  });
});
