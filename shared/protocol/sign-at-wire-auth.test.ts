import { describe, expect, it } from 'vitest';
import type { AuthType } from '../types/auth';
import { signAtWireAuthLabel } from './sign-at-wire-auth';

describe('signAtWireAuthLabel', () => {
  it('labels every auth type that only exists at the wire', () => {
    const all: AuthType[] = [
      'none',
      'basic',
      'bearer',
      'api-key',
      'oauth2',
      'digest',
      'aws-signature',
      'oauth1',
      'ntlm',
      'wsse',
    ];
    expect(Object.fromEntries(all.map((t) => [t, signAtWireAuthLabel(t) ?? null]))).toEqual({
      none: null,
      basic: null,
      bearer: null,
      'api-key': null,
      oauth2: null,
      digest: 'Digest',
      'aws-signature': 'AWS Signature',
      oauth1: 'OAuth 1.0',
      ntlm: 'NTLM',
      wsse: 'WSSE',
    });
    expect(signAtWireAuthLabel(undefined)).toBeUndefined();
  });
});
