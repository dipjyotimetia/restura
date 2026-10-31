import { describe, expect, it } from 'vitest';
import { computeElo, type PairwiseMatch, winRateMatrix } from '../elo';

describe('computeElo', () => {
  it('ranks a consistent winner above the loser', () => {
    const matches: PairwiseMatch[] = Array.from({ length: 5 }, () => ({
      a: 'A',
      b: 'B',
      winner: 'a' as const,
    }));
    const board = computeElo(['A', 'B'], matches);
    expect(board[0]!.key).toBe('A');
    expect(board[0]!.rating).toBeGreaterThan(board[1]!.rating);
    expect(board[0]!.wins).toBe(5);
    expect(board[1]!.losses).toBe(5);
  });

  it('keeps equal ratings when everything ties', () => {
    const matches: PairwiseMatch[] = [{ a: 'A', b: 'B', winner: 'tie' }];
    const board = computeElo(['A', 'B'], matches);
    expect(board[0]!.rating).toBe(board[1]!.rating);
    expect(board[0]!.ties).toBe(1);
  });

  it('is deterministic for the same input order', () => {
    const matches: PairwiseMatch[] = [
      { a: 'A', b: 'B', winner: 'a' },
      { a: 'B', b: 'C', winner: 'b' },
      { a: 'A', b: 'C', winner: 'a' },
    ];
    const r1 = computeElo(['A', 'B', 'C'], matches);
    const r2 = computeElo(['A', 'B', 'C'], matches);
    expect(r1).toEqual(r2);
  });
});

describe('winRateMatrix', () => {
  it('computes row-vs-column decisive win rates', () => {
    const matches: PairwiseMatch[] = [
      { a: 'A', b: 'B', winner: 'a' },
      { a: 'A', b: 'B', winner: 'b' },
      { a: 'A', b: 'B', winner: 'a' },
    ];
    const m = winRateMatrix(['A', 'B'], matches);
    expect(m.A!.B!.rate).toBeCloseTo(2 / 3);
    expect(m.B!.A!.rate).toBeCloseTo(1 / 3);
    expect(m.A!.A!.rate).toBeNull();
  });
});

describe('errored matches (#1023)', () => {
  const errored = { a: 'x', b: 'y', winner: 'error' as const, error: 'boom' };

  it('excludes errored matches from Elo ratings and game counts', () => {
    const elo = computeElo(['x', 'y'], [errored, errored]);
    expect(elo.map((e) => [e.rating, e.games])).toEqual([
      [1000, 0],
      [1000, 0],
    ]);
  });

  it('excludes errored matches from the win-rate matrix', () => {
    const matrix = winRateMatrix(['x', 'y'], [errored, { a: 'x', b: 'y', winner: 'a' }]);
    expect(matrix.x?.y).toEqual({ rate: 1, wins: 1, losses: 0, ties: 0 });
  });
});
