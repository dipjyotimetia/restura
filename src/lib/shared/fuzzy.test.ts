import { describe, expect, it } from 'vitest';
import { fuzzyScore } from './fuzzy';

describe('fuzzyScore', () => {
  it('matches subsequences and rejects out-of-order or missing characters', () => {
    expect(fuzzyScore('nhr', 'New HTTP request')).not.toBeNull();
    expect(fuzzyScore('rhn', 'New HTTP request')).toBeNull();
    expect(fuzzyScore('xyz', 'New HTTP request')).toBeNull();
  });

  it('treats an empty query as a neutral match and ignores case and spaces', () => {
    expect(fuzzyScore('  ', 'anything')).toBe(0);
    expect(fuzzyScore('N H', 'new http')).not.toBeNull();
  });

  it('ranks substrings above scattered matches, and earlier/word-start substrings higher', () => {
    const sub = fuzzyScore('theme', 'Switch to dark theme') as number;
    const scattered = fuzzyScore('tdt', 'Switch to dark theme') as number;
    expect(sub).toBeGreaterThan(scattered);
    expect(fuzzyScore('set', 'Settings') as number).toBeGreaterThan(
      fuzzyScore('set', 'Reset layout') as number
    );
  });

  it('prefers word-start and contiguous characters among subsequences', () => {
    expect(fuzzyScore('gc', 'Generate code') as number).toBeGreaterThan(
      fuzzyScore('gc', 'Big cat') as number
    );
  });

  it('finds commands by their initials', () => {
    const candidates = [
      'Reopen closed tab',
      'Run load test on current request',
      'Generate code for current request',
      'Toggle network console',
    ];
    const best = candidates
      .map((c) => ({ c, s: fuzzyScore('rct', c) }))
      .filter((x) => x.s !== null)
      .sort((a, b) => (b.s as number) - (a.s as number))[0];
    expect(best?.c).toBe('Reopen closed tab');
  });
});
