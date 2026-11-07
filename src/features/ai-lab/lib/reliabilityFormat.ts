/**
 * Display helpers for AI Lab reliability metrics (pass@k / pass^k) and the
 * short explanations shown as tooltips next to them.
 */

/** `{1: 0.8, 3: 0.95}` → `pass@1 80% · pass@3 95%` (sorted by k). */
export function formatAtK(prefix: 'pass@' | 'pass^', values: Record<number, number>): string {
  const entries = Object.entries(values)
    .map(([k, v]) => [Number(k), v] as const)
    .filter(([k, v]) => Number.isFinite(k) && Number.isFinite(v))
    .sort(([a], [b]) => a - b);
  if (entries.length === 0) return `${prefix}k —`;
  return entries.map(([k, v]) => `${prefix}${k} ${Math.round(v * 100)}%`).join(' · ');
}

export function formatReliability(
  passAtK: Record<number, number>,
  passToK: Record<number, number>
): string {
  return `${formatAtK('pass@', passAtK)} · ${formatAtK('pass^', passToK)}`;
}

export const METRIC_HELP = {
  passAtK:
    'pass@k: chance that at least one of k attempts passes. pass^k: chance that all k attempts pass (consistency).',
  elo: 'Elo: relative rating from pairwise votes; a win against a higher-rated model gains more points. Models start at 1000.',
} as const;
