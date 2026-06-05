// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

// auth-applier resolves secrets via secret-handle-store (which imports electron).
// Mock it with a pass-through that mirrors unwrapSecretValueMain's contract for
// strings and inline refs, and resolves handles from a fixture table.
vi.mock('../secret-handle-store', () => ({
  unwrapSecretValueMain: (value: unknown): string | undefined => {
    if (value == null) return undefined;
    if (typeof value === 'string') return value;
    if (typeof value === 'object') {
      const v = value as { kind?: string; value?: string; id?: string };
      if (v.kind === 'inline') return v.value;
      if (v.kind === 'handle') return v.id === 'h1' ? 'resolved-secret' : undefined;
    }
    return undefined;
  },
}));

import { applyNonSignAtWireAuth } from '../auth-applier';

describe('applyNonSignAtWireAuth', () => {
  it('returns empty for undefined and for type "none"', () => {
    expect(applyNonSignAtWireAuth(undefined)).toEqual({ headers: {}, params: {} });
    expect(applyNonSignAtWireAuth({ type: 'none' } as never)).toEqual({ headers: {}, params: {} });
  });

  it('builds a Bearer header from a plain token', () => {
    const out = applyNonSignAtWireAuth({ type: 'bearer', bearer: { token: 'abc' } } as never);
    expect(out.headers).toEqual({ Authorization: 'Bearer abc' });
  });

  it('resolves a handle-backed bearer token main-side', () => {
    const out = applyNonSignAtWireAuth({
      type: 'bearer',
      bearer: { token: { kind: 'handle', id: 'h1' } },
    } as never);
    expect(out.headers.Authorization).toBe('Bearer resolved-secret');
  });

  it('base64-encodes basic credentials', () => {
    const out = applyNonSignAtWireAuth({
      type: 'basic',
      basic: { username: 'user', password: 'pass' },
    } as never);
    const decoded = Buffer.from(
      out.headers.Authorization!.replace('Basic ', ''),
      'base64'
    ).toString();
    expect(decoded).toBe('user:pass');
  });

  it('returns empty when basic username is missing', () => {
    const out = applyNonSignAtWireAuth({
      type: 'basic',
      basic: { username: '', password: 'p' },
    } as never);
    expect(out).toEqual({ headers: {}, params: {} });
  });

  it('puts an api-key in the header by default', () => {
    const out = applyNonSignAtWireAuth({
      type: 'api-key',
      apiKey: { key: 'X-Api-Key', value: 'secret', in: 'header' },
    } as never);
    expect(out.headers).toEqual({ 'X-Api-Key': 'secret' });
    expect(out.params).toEqual({});
  });

  it('puts an api-key in the query when in:"query"', () => {
    const out = applyNonSignAtWireAuth({
      type: 'api-key',
      apiKey: { key: 'token', value: 'secret', in: 'query' },
    } as never);
    expect(out.params).toEqual({ token: 'secret' });
    expect(out.headers).toEqual({});
  });

  it('uses the oauth2 tokenType, defaulting to Bearer', () => {
    expect(
      applyNonSignAtWireAuth({ type: 'oauth2', oauth2: { accessToken: 't' } } as never).headers
        .Authorization
    ).toBe('Bearer t');
    expect(
      applyNonSignAtWireAuth({
        type: 'oauth2',
        oauth2: { accessToken: 't', tokenType: 'MAC' },
      } as never).headers.Authorization
    ).toBe('MAC t');
  });

  it('returns empty for sign-at-wire types (handled elsewhere)', () => {
    for (const type of ['aws-signature', 'oauth1', 'wsse', 'ntlm', 'digest'] as const) {
      expect(applyNonSignAtWireAuth({ type } as never)).toEqual({ headers: {}, params: {} });
    }
  });
});
