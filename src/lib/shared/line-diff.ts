/**
 * Minimal line-level LCS diff for the console's compare dialog. We deliberately
 * keep this in-tree (no `diff` npm dep) — the only callers are visual diffs of
 * captured bodies and concatenated header blocks, so a 20-line LCS gets us:
 *   - "equal" lines (the common subsequence)
 *   - "removed" lines (in `a` only)
 *   - "added" lines (in `b` only)
 *
 * Complexity is O(m·n) in both time AND memory — the (m+1)·(n+1) table is
 * allocated up front. At MAX_DIFF_LINES = 800 the worst case is
 * 801·801 ≈ 640 k cells, ~5 MB on V8's packed small-int representation —
 * well within budget for a click-to-open dialog. Above the threshold we fall
 * back to a coarse "all-removed then all-added" diff so the dialog stays
 * responsive on multi-thousand-line bodies.
 */

export type LineDiffOp = 'equal' | 'added' | 'removed';

export interface LineDiffEntry {
  op: LineDiffOp;
  text: string;
}

export const MAX_DIFF_LINES = 800;

function toLines(s: string): string[] {
  // Treat empty input as zero lines (avoid a spurious "1 line" diff for "").
  if (!s) return [];
  return s.split(/\r?\n/);
}

/** LCS length table for two line arrays — standard DP. */
function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const t: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      t[i]![j] = a[i] === b[j] ? (t[i + 1]![j + 1]! + 1) : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
    }
  }
  return t;
}

/** Walk the LCS table to emit the unified diff sequence. */
export function diffLines(left: string, right: string): LineDiffEntry[] {
  const a = toLines(left);
  const b = toLines(right);

  // Cheap-out for huge inputs — keep the dialog responsive.
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    const out: LineDiffEntry[] = [];
    for (const line of a) out.push({ op: 'removed', text: line });
    for (const line of b) out.push({ op: 'added', text: line });
    return out;
  }

  const t = lcsTable(a, b);
  const out: LineDiffEntry[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: 'equal', text: a[i]! });
      i++; j++;
    } else if ((t[i + 1]?.[j] ?? 0) >= (t[i]?.[j + 1] ?? 0)) {
      out.push({ op: 'removed', text: a[i]! });
      i++;
    } else {
      out.push({ op: 'added', text: b[j]! });
      j++;
    }
  }
  while (i < a.length) { out.push({ op: 'removed', text: a[i++]! }); }
  while (j < b.length) { out.push({ op: 'added', text: b[j++]! }); }
  return out;
}
