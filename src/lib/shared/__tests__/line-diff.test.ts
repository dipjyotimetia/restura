import { describe, it, expect } from 'vitest';
import { diffLines, MAX_DIFF_LINES } from '@/lib/shared/line-diff';

const ops = (left: string, right: string) =>
  diffLines(left, right).map((e) => `${e.op}:${e.text}`);

describe('diffLines', () => {
  it('emits only equal entries when inputs match', () => {
    expect(ops('a\nb\nc', 'a\nb\nc')).toEqual(['equal:a', 'equal:b', 'equal:c']);
  });

  it('marks the changed line as removed+added, keeps surrounding equal', () => {
    expect(ops('a\nB\nc', 'a\nb\nc')).toEqual(['equal:a', 'removed:B', 'added:b', 'equal:c']);
  });

  it('handles pure additions', () => {
    expect(ops('', 'x\ny')).toEqual(['added:x', 'added:y']);
  });

  it('handles pure removals', () => {
    expect(ops('x\ny', '')).toEqual(['removed:x', 'removed:y']);
  });

  it('handles interleaved diffs', () => {
    expect(ops('a\nb\nc', 'a\nx\nc')).toEqual(['equal:a', 'removed:b', 'added:x', 'equal:c']);
  });

  it('treats empty input as zero lines (no phantom blank)', () => {
    expect(diffLines('', '')).toEqual([]);
  });

  it('coarse-mode bails out above MAX_DIFF_LINES', () => {
    const big = new Array(MAX_DIFF_LINES + 5).fill('x').join('\n');
    const ds = diffLines(big, 'y');
    // Every line on the left is removed, then the single right line is added —
    // no LCS walk took place.
    expect(ds[0]!.op).toBe('removed');
    expect(ds[ds.length - 1]!.op).toBe('added');
    expect(ds.filter((e) => e.op === 'equal').length).toBe(0);
  });

  it('MAX_DIFF_LINES is conservative enough to keep memory bounded', () => {
    // The (m+1)·(n+1) table allocates up front; a 2000-line threshold meant
    // ~32 MB peak. 800 keeps the worst case at ~5 MB. Lock the value here so
    // a future bump is intentional rather than accidental.
    expect(MAX_DIFF_LINES).toBeLessThanOrEqual(1000);
  });
});
