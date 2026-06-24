// Fold pairwise match results into an Elo leaderboard + win-rate matrix. Pure
// and deterministic (fixed K-factor, caller-ordered matches) so the Arena view
// and its tests produce identical ratings for identical inputs.

/** One head-to-head result between two model keys. */
export interface PairwiseMatch {
  a: string;
  b: string;
  /** 'a' = a won, 'b' = b won, 'tie'. */
  winner: 'a' | 'b' | 'tie';
}

export interface EloEntry {
  key: string;
  rating: number;
  wins: number;
  losses: number;
  ties: number;
  games: number;
}

export interface WinRateCell {
  /** Wins of row vs column / decisive games (ties excluded). null = no games. */
  rate: number | null;
  wins: number;
  losses: number;
  ties: number;
}

const DEFAULT_RATING = 1000;
const K = 32;

function expectedScore(ra: number, rb: number): number {
  return 1 / (1 + 10 ** ((rb - ra) / 400));
}

/**
 * Compute Elo ratings from a sequence of matches. Order matters (Elo is path
 * dependent), so callers pass matches in a stable order for reproducibility.
 * A tie scores 0.5 / 0.5.
 */
export function computeElo(keys: string[], matches: PairwiseMatch[]): EloEntry[] {
  const rating = new Map<string, number>();
  const stat = new Map<string, { wins: number; losses: number; ties: number; games: number }>();
  for (const k of keys) {
    rating.set(k, DEFAULT_RATING);
    stat.set(k, { wins: 0, losses: 0, ties: 0, games: 0 });
  }
  const ensure = (k: string) => {
    if (!rating.has(k)) rating.set(k, DEFAULT_RATING);
    if (!stat.has(k)) stat.set(k, { wins: 0, losses: 0, ties: 0, games: 0 });
  };

  for (const m of matches) {
    ensure(m.a);
    ensure(m.b);
    const ra = rating.get(m.a)!;
    const rb = rating.get(m.b)!;
    const ea = expectedScore(ra, rb);
    const eb = expectedScore(rb, ra);
    const sa = m.winner === 'a' ? 1 : m.winner === 'b' ? 0 : 0.5;
    const sb = 1 - sa;
    rating.set(m.a, ra + K * (sa - ea));
    rating.set(m.b, rb + K * (sb - eb));

    const stA = stat.get(m.a)!;
    const stB = stat.get(m.b)!;
    stA.games++;
    stB.games++;
    if (m.winner === 'a') {
      stA.wins++;
      stB.losses++;
    } else if (m.winner === 'b') {
      stB.wins++;
      stA.losses++;
    } else {
      stA.ties++;
      stB.ties++;
    }
  }

  return [...rating.entries()]
    .map(([key, r]) => {
      const s = stat.get(key)!;
      return { key, rating: Math.round(r), ...s };
    })
    .sort((x, y) => y.rating - x.rating);
}

/** Build a row×column win-rate matrix (row vs column) keyed by model. */
export function winRateMatrix(
  keys: string[],
  matches: PairwiseMatch[]
): Record<string, Record<string, WinRateCell>> {
  const matrix: Record<string, Record<string, WinRateCell>> = {};
  for (const r of keys) {
    matrix[r] = {};
    for (const c of keys) matrix[r]![c] = { rate: null, wins: 0, losses: 0, ties: 0 };
  }
  const bump = (r: string, c: string, kind: 'wins' | 'losses' | 'ties') => {
    if (!matrix[r]) matrix[r] = {};
    if (!matrix[r]![c]) matrix[r]![c] = { rate: null, wins: 0, losses: 0, ties: 0 };
    matrix[r]![c]![kind]++;
  };
  for (const m of matches) {
    if (m.winner === 'a') {
      bump(m.a, m.b, 'wins');
      bump(m.b, m.a, 'losses');
    } else if (m.winner === 'b') {
      bump(m.a, m.b, 'losses');
      bump(m.b, m.a, 'wins');
    } else {
      bump(m.a, m.b, 'ties');
      bump(m.b, m.a, 'ties');
    }
  }
  for (const r of Object.keys(matrix)) {
    for (const c of Object.keys(matrix[r]!)) {
      const cell = matrix[r]![c]!;
      const decisive = cell.wins + cell.losses;
      cell.rate = decisive > 0 ? cell.wins / decisive : null;
    }
  }
  return matrix;
}
