// @vitest-environment node
import './setup';
import { describe, it, expect, vi } from 'vitest';

// Resolve handle ids deterministically so the gRPC auth merge is testable
// without the real OS-keychain-backed store.
vi.mock('../secret-handle-store', () => ({
  unwrapSecretValueMain: (v: unknown) =>
    v && typeof v === 'object' && (v as { kind?: string }).kind === 'handle'
      ? 'resolved-secret'
      : typeof v === 'object' && v !== null
        ? (v as { value?: string }).value
        : v,
}));

import { mergeMainSideAuth } from '../grpc-handler';

describe('mergeMainSideAuth (SecretRef handle resolution)', () => {
  it('returns metadata unchanged when no auth descriptor is present', () => {
    const md = { traceparent: 'x' };
    expect(mergeMainSideAuth(md, undefined)).toBe(md);
  });

  it('resolves a bearer handle main-side and adds a lowercase authorization metadata key', () => {
    const merged = mergeMainSideAuth({ traceparent: 'x' }, {
      type: 'bearer',
      bearer: { token: { kind: 'handle', id: 'h-1' } },
    } as never);
    expect(merged['authorization']).toBe('Bearer resolved-secret');
    expect(merged['traceparent']).toBe('x');
  });

  it('resolves an api-key handle into its (lowercased) header key', () => {
    const merged = mergeMainSideAuth({}, {
      type: 'api-key',
      apiKey: { key: 'X-API-Key', value: { kind: 'handle', id: 'h-2' }, in: 'header' },
    } as never);
    expect(merged['x-api-key']).toBe('resolved-secret');
  });

  it('does not mutate the input metadata object', () => {
    const original = { traceparent: 'x' };
    const merged = mergeMainSideAuth(original, {
      type: 'bearer',
      bearer: { token: { kind: 'handle', id: 'h-3' } },
    } as never);
    expect(original['traceparent' as keyof typeof original]).toBe('x');
    expect(Object.keys(original)).toEqual(['traceparent']);
    expect(merged).not.toBe(original);
  });
});
