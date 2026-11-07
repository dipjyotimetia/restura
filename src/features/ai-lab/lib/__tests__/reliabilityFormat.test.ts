import { describe, expect, it } from 'vitest';
import { formatAtK, formatReliability } from '../reliabilityFormat';

describe('reliability formatting', () => {
  it('formats pass@k as sorted percentages, not JSON', () => {
    expect(formatAtK('pass@', { 3: 0.95, 1: 0.8 })).toBe('pass@1 80% · pass@3 95%');
  });

  it('formats pass^k and the combined line', () => {
    expect(formatReliability({ 1: 0.8 }, { 1: 0.8, 3: 0.512 })).toBe(
      'pass@1 80% · pass^1 80% · pass^3 51%'
    );
  });

  it('shows a dash when there are no values', () => {
    expect(formatAtK('pass@', {})).toBe('pass@k —');
  });
});
