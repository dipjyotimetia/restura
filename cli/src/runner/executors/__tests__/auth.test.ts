import { describe, expect, it } from 'vitest';
import { applyAuthHeaders, toProtocolAuth } from '../auth';

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
