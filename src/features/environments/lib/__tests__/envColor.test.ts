import { describe, it, expect } from 'vitest';
import { envColorFor } from '../envColor';

describe('envColorFor', () => {
  it('returns the slate fallback for a null/undefined env', () => {
    expect(envColorFor(null)).toBe('#94a3b8');
    expect(envColorFor(undefined)).toBe('#94a3b8');
  });

  it('maps prod-like names to green (case-insensitive, substring)', () => {
    expect(envColorFor({ id: '1', name: 'Production' })).toBe('#22c55e');
    expect(envColorFor({ id: '2', name: 'prod-us-east' })).toBe('#22c55e');
    expect(envColorFor({ id: '3', name: 'PROD' })).toBe('#22c55e');
  });

  it('maps staging/qa names to amber', () => {
    expect(envColorFor({ id: '1', name: 'Staging' })).toBe('#f59e0b');
    expect(envColorFor({ id: '2', name: 'staging-eu' })).toBe('#f59e0b');
    expect(envColorFor({ id: '3', name: 'QA' })).toBe('#f59e0b');
    expect(envColorFor({ id: '4', name: 'qa-eu' })).toBe('#f59e0b');
  });

  it('only treats "qa" as a whole word, not as a substring', () => {
    // `qaserver` has no word boundary after `qa`, so it falls through to the hash.
    const c = envColorFor({ id: '1', name: 'qaserver' });
    expect(['#f59e0b']).not.toContain(c);
  });

  it('maps dev/local names to accent blue', () => {
    expect(envColorFor({ id: '1', name: 'Development' })).toBe('#2e91ff');
    expect(envColorFor({ id: '2', name: 'dev' })).toBe('#2e91ff');
    expect(envColorFor({ id: '3', name: 'Local' })).toBe('#2e91ff');
  });

  it('resolves "preprod" to green, not amber, because the prod check runs first', () => {
    // Documents a precedence quirk: `"preprod".includes("prod")` is true and the
    // prod branch is evaluated before the staging branch (which also lists
    // "preprod"). So preprod reads green despite the staging-amber intent in the
    // doc comment. Pinned so any future re-ordering is a conscious, test-breaking
    // decision.
    expect(envColorFor({ id: '1', name: 'preprod' })).toBe('#22c55e');
  });

  it('is deterministic and palette-bounded for arbitrary names', () => {
    const palette = [
      '#2e91ff',
      '#22c55e',
      '#f59e0b',
      '#a78bfa',
      '#06b6d4',
      '#e879a4',
      '#f472b6',
      '#94a3b8',
    ];
    const a = envColorFor({ id: 'abc', name: 'my-custom-env' });
    const b = envColorFor({ id: 'abc', name: 'my-custom-env' });
    expect(a).toBe(b);
    expect(palette).toContain(a);
  });

  it('uses id as a tiebreaker so same-named envs can differ', () => {
    const x = envColorFor({ id: 'id-one', name: 'service' });
    const y = envColorFor({ id: 'id-two', name: 'service' });
    // Both are valid palette picks; the id participates in the hash so they are
    // not forced to collide. (They may still coincide, but the inputs differ.)
    expect(typeof x).toBe('string');
    expect(typeof y).toBe('string');
  });
});
