/**
 * Structural parity between the renderer's redirect-policy fields on
 * `RequestSettings` (`src/types/http.ts`) and the shared protocol core's
 * `RedirectPolicy` (`shared/protocol/types.ts`) + its Zod mirror
 * `RedirectPolicySchema` (`shared/protocol/proxy-schema.ts`).
 *
 * `RedirectPolicy` is the wire-shape the renderer threads into the shared
 * redirect-follower. If a new redirect knob is added to `RequestSettings` but
 * not to `RedirectPolicy`, desktop/web user intent silently stops reaching the
 * follower. The compile-time checks below catch per-field drift.
 */
import { describe, it, expect } from 'vitest';
import type { RequestSettings } from '@/types';
import type { RedirectPolicy } from '@shared/protocol/types';
import { RedirectPolicySchema } from '@shared/protocol/proxy-schema';
import { expectTypeEqual, type Equals } from './helpers/typeEquality';

describe('RedirectPolicy / RequestSettings parity', () => {
  it('each redirect field has a matching type on both sides (compile-time)', () => {
    expectTypeEqual<
      Equals<RequestSettings['followOriginalMethod'], RedirectPolicy['followOriginalMethod']>
    >();
    expectTypeEqual<
      Equals<RequestSettings['followAuthHeader'], RedirectPolicy['followAuthHeader']>
    >();
    expectTypeEqual<Equals<RequestSettings['stripReferer'], RedirectPolicy['stripReferer']>>();
    // maxRedirects is required on RequestSettings, optional on RedirectPolicy —
    // compare the non-nullable element type.
    expectTypeEqual<
      Equals<
        NonNullable<RequestSettings['maxRedirects']>,
        NonNullable<RedirectPolicy['maxRedirects']>
      >
    >();
  });

  it('a RequestSettings-derived redirect subset parses against the schema (runtime)', () => {
    const fromSettings: Pick<
      RequestSettings,
      'followOriginalMethod' | 'followAuthHeader' | 'stripReferer' | 'maxRedirects'
    > = {
      followOriginalMethod: true,
      followAuthHeader: false,
      stripReferer: true,
      maxRedirects: 5,
    };
    const policy: RedirectPolicy = fromSettings;
    expect(RedirectPolicySchema.safeParse(policy).success).toBe(true);
  });
});
