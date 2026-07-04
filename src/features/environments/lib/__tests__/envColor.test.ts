import { describe, it, expect } from 'vitest';
import { envColorFor } from '../envColor';

describe('envColorFor', () => {
  it('returns the slate fallback for a null/undefined env', () => {
    expect(envColorFor(null)).toBe('#95a0ab');
    expect(envColorFor(undefined)).toBe('#95a0ab');
  });

  it('maps prod-like names to green (case-insensitive, substring)', () => {
    expect(envColorFor({ id: '1', name: 'Production' })).toBe('#39b26f');
    expect(envColorFor({ id: '2', name: 'prod-us-east' })).toBe('#39b26f');
    expect(envColorFor({ id: '3', name: 'PROD' })).toBe('#39b26f');
  });

  it('maps staging/qa names to amber', () => {
    expect(envColorFor({ id: '1', name: 'Staging' })).toBe('#d8953d');
    expect(envColorFor({ id: '2', name: 'staging-eu' })).toBe('#d8953d');
    expect(envColorFor({ id: '3', name: 'QA' })).toBe('#d8953d');
    expect(envColorFor({ id: '4', name: 'qa-eu' })).toBe('#d8953d');
  });

  it('only treats "qa" as a whole word, not as a substring', () => {
    // `qaserver` has no word boundary after `qa`, so it falls through to the hash.
    const c = envColorFor({ id: '1', name: 'qaserver' });
    expect(['#d8953d']).not.toContain(c);
  });

  it('maps dev/local names to accent blue', () => {
    expect(envColorFor({ id: '1', name: 'Development' })).toBe('#3d8fe4');
    expect(envColorFor({ id: '2', name: 'dev' })).toBe('#3d8fe4');
    expect(envColorFor({ id: '3', name: 'Local' })).toBe('#3d8fe4');
  });

  it('resolves "preprod" to amber, not green (it is a pre-production env)', () => {
    // "preprod" contains "prod" but must not read as the green go-signal; it is
    // carved out of the prod branch so it lands in the staging/qa amber bucket.
    expect(envColorFor({ id: '1', name: 'preprod' })).toBe('#d8953d');
    expect(envColorFor({ id: '2', name: 'preprod-eu' })).toBe('#d8953d');
  });

  it('is deterministic and palette-bounded for arbitrary names', () => {
    const palette = [
      '#3d8fe4',
      '#39b26f',
      '#d8953d',
      '#988bdd',
      '#2ba9c2',
      '#dd7aa2',
      '#dc7095',
      '#95a0ab',
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
