/**
 * Structural parity between the renderer's `AuthConfig` / `AuthType`
 * (`src/types/auth.ts`) and the shared protocol core's `ProtocolAuthConfig` /
 * `ProtocolAuthType` (`shared/protocol/types.ts`) + its Zod mirror
 * `ProtocolAuthConfigSchema` (`shared/protocol/proxy-schema.ts`).
 *
 * The three declarations are duplicated by design — `shared/protocol/` must
 * not import from `src/`. This test fails (compile-time and/or runtime) if
 * they drift, so a maintainer who adds an auth type or a sign-at-wire field
 * to one must update all of them together.
 */

import { ProtocolAuthConfigSchema } from '@shared/protocol/proxy-schema';
import type { ProtocolAuthConfig, ProtocolAuthType } from '@shared/protocol/types';
import { describe, expect, it } from 'vitest';
import type { AuthConfig, AuthType } from '@/types';
import { type Equals, expectTypeEqual } from './helpers/typeEquality';

describe('AuthType / ProtocolAuthType parity', () => {
  it('the renderer and protocol auth-type unions are identical (compile-time)', () => {
    expectTypeEqual<Equals<AuthType, ProtocolAuthType>>();
    // The shared type and its Zod schema enum must also agree.
    expectTypeEqual<
      Equals<ProtocolAuthType, ReturnType<typeof ProtocolAuthConfigSchema.parse>['type']>
    >();
  });

  it('every AuthType member is accepted by the protocol schema (runtime)', () => {
    // The Record forces this list to be exhaustive over AuthType at compile
    // time — a new member without a key here is a type error.
    const allAuthTypes: Record<AuthType, true> = {
      none: true,
      basic: true,
      bearer: true,
      'api-key': true,
      oauth2: true,
      digest: true,
      'aws-signature': true,
      oauth1: true,
      ntlm: true,
      wsse: true,
    };
    for (const type of Object.keys(allAuthTypes)) {
      expect(ProtocolAuthConfigSchema.safeParse({ type }).success).toBe(true);
    }
  });

  it('rejects an auth type outside the union (runtime)', () => {
    expect(ProtocolAuthConfigSchema.safeParse({ type: 'kerberos' }).success).toBe(false);
  });
});

describe('sign-at-wire auth sub-shapes are mutually assignable', () => {
  it('aws-signature / oauth1 / ntlm / wsse match between renderer and protocol (compile-time)', () => {
    // These are the only auth shapes the shared core acts on; they must stay
    // structurally interchangeable with the renderer's (modulo SecretValue,
    // itself guarded by tests/secret-ref-parity.test.ts).
    expectTypeEqual<Equals<AuthConfig['awsSignature'], ProtocolAuthConfig['awsSignature']>>();
    expectTypeEqual<Equals<AuthConfig['oauth1'], ProtocolAuthConfig['oauth1']>>();
    expectTypeEqual<Equals<AuthConfig['ntlm'], ProtocolAuthConfig['ntlm']>>();
    expectTypeEqual<Equals<AuthConfig['wsse'], ProtocolAuthConfig['wsse']>>();
  });

  it('representative sign-at-wire configs parse against the protocol schema (runtime)', () => {
    const samples: ProtocolAuthConfig[] = [
      {
        type: 'aws-signature',
        awsSignature: { accessKey: 'AK', secretKey: 'sk', region: 'us-east-1', service: 's3' },
      },
      {
        type: 'oauth1',
        oauth1: { consumerKey: 'ck', consumerSecret: { kind: 'inline', value: 'cs' } },
      },
      { type: 'ntlm', ntlm: { username: 'u', password: { kind: 'handle', id: 'h1' } } },
      { type: 'wsse', wsse: { username: 'u', password: 'p', passwordType: 'PasswordDigest' } },
    ];
    for (const s of samples) {
      expect(ProtocolAuthConfigSchema.safeParse(s).success).toBe(true);
    }
  });
});
