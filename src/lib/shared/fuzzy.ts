/**
 * Small fuzzy matcher for the command palette: every query character must
 * appear in order (a subsequence). Higher scores for contiguous runs, matches
 * at word starts and at the very beginning. Returns null for no match.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();

  // A plain substring always beats a scattered subsequence.
  const at = t.indexOf(q);
  if (at !== -1) return 1000 - at + (isWordStart(t, at) ? 100 : 0);

  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    score += 1;
    if (found === prev + 1) score += 5;
    if (isWordStart(t, found)) score += 8;
    prev = found;
    ti = found + 1;
  }
  return score;
}

function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true;
  return /[\s/._:\-]/.test(text[index - 1] ?? '');
}
