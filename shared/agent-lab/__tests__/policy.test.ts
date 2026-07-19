import { describe, expect, it } from 'vitest';
import { evaluateToolPolicy, isCiSafePolicy } from '../policy';

describe('agent policy profiles', () => {
  it('defaults sensitive tools to an approval-required decision', () => {
    expect(evaluateToolPolicy(undefined, 'mutation')).toEqual({
      decision: 'approval-required',
      reason: 'explicit approval required for mutation tool',
    });
  });

  it('allows an explicitly auto-approved desktop permission', () => {
    expect(
      evaluateToolPolicy(
        {
          id: 'local-write',
          name: 'Local write workflow',
          version: 1,
          autoApprove: ['mutation'],
          ciEligible: false,
        },
        'mutation'
      )
    ).toEqual({ decision: 'allowed', reason: 'policy local-write auto-approved mutation tool' });
  });

  it('only accepts read-only policy profiles as CI-safe', () => {
    expect(
      isCiSafePolicy({
        id: 'ci-read',
        name: 'CI read-only',
        version: 1,
        autoApprove: ['read'],
        ciEligible: true,
      })
    ).toBe(true);
    expect(
      isCiSafePolicy({
        id: 'ci-write',
        name: 'CI write',
        version: 1,
        autoApprove: ['read', 'mutation'],
        ciEligible: true,
      })
    ).toBe(false);
  });
});
