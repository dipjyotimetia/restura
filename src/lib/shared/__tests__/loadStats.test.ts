import { describe, expect, it } from 'vitest';
import { computeLoadStats, percentile } from '../loadStats';

describe('percentile', () => {
  it('returns 0 for empty input', () => {
    expect(percentile([], 95)).toBe(0);
  });

  it('computes nearest-rank percentiles', () => {
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(data, 50)).toBe(5);
    expect(percentile(data, 90)).toBe(9);
    expect(percentile(data, 100)).toBe(10);
  });

  it('does not mutate the input', () => {
    const data = [3, 1, 2];
    percentile(data, 50);
    expect(data).toEqual([3, 1, 2]);
  });
});

describe('computeLoadStats', () => {
  it('handles empty samples', () => {
    const s = computeLoadStats([], 1000, 0);
    expect(s).toMatchObject({ count: 0, rps: 0, p95: 0 });
  });

  it('computes min/max/mean and rps', () => {
    const s = computeLoadStats([10, 20, 30, 40], 2000, 1);
    expect(s.count).toBe(4);
    expect(s.errors).toBe(1);
    expect(s.min).toBe(10);
    expect(s.max).toBe(40);
    expect(s.mean).toBe(25);
    expect(s.rps).toBeCloseTo(2, 5); // 4 reqs / 2s
  });
});
