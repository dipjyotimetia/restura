import type { Trace } from './types';

function productRatio(numeratorStart: number, denominatorStart: number, count: number): number {
  let ratio = 1;
  for (let index = 0; index < count; index += 1) {
    ratio *= (numeratorStart - index) / (denominatorStart - index);
  }
  return ratio;
}

/** Probability that at least one of k samples passes, without replacement. */
export function passAtK(total: number, passed: number, k: number): number {
  validateTrialCounts(total, passed, k);
  if (passed === 0) return 0;
  if (total - passed < k) return 1;
  return 1 - productRatio(total - passed, total, k);
}

/** Probability that all k samples pass, also commonly written pass^k. */
export function passToK(total: number, passed: number, k: number): number {
  validateTrialCounts(total, passed, k);
  if (passed < k) return 0;
  return productRatio(passed, total, k);
}

function validateTrialCounts(total: number, passed: number, k: number): void {
  if (!Number.isInteger(total) || !Number.isInteger(passed) || !Number.isInteger(k)) {
    throw new Error('trial counts must be integers');
  }
  if (total < 1 || passed < 0 || passed > total || k < 1 || k > total) {
    throw new Error('invalid trial counts');
  }
}

export function wilsonInterval(
  passed: number,
  total: number,
  z = 1.959963984540054
): { low: number; high: number } {
  if (total === 0) return { low: 0, high: 1 };
  if (passed < 0 || passed > total) throw new Error('invalid pass count');
  const proportion = passed / total;
  const zSquared = z * z;
  const denominator = 1 + zSquared / total;
  const center = (proportion + zSquared / (2 * total)) / denominator;
  const margin =
    (z / denominator) *
    Math.sqrt((proportion * (1 - proportion)) / total + zSquared / (4 * total * total));
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

export interface TrajectoryExpectation {
  mode: 'exact' | 'in-order' | 'subsequence' | 'unordered';
  tools: string[];
}

export interface TrajectoryScore {
  passed: boolean;
  actual: string[];
  expected: string[];
  detail?: string;
}

export function scoreTrajectory(trace: Trace, expectation: TrajectoryExpectation): TrajectoryScore {
  const actual = trace.events
    .filter((event) => event.type === 'tool.requested')
    .map((event) => event.toolName);
  const expected = expectation.tools;
  let passed: boolean;
  switch (expectation.mode) {
    case 'exact':
      passed =
        actual.length === expected.length &&
        actual.every((tool, index) => tool === expected[index]);
      break;
    case 'in-order':
      passed = expected.every((tool, index) => actual[index] === tool);
      break;
    case 'subsequence': {
      let expectedIndex = 0;
      for (const tool of actual) {
        if (tool === expected[expectedIndex]) expectedIndex += 1;
      }
      passed = expectedIndex === expected.length;
      break;
    }
    case 'unordered':
      passed =
        actual.length === expected.length &&
        [...actual].sort().every((tool, index) => tool === [...expected].sort()[index]);
      break;
  }
  return {
    passed,
    actual,
    expected: [...expected],
    ...(passed
      ? {}
      : {
          detail: `expected ${expectation.mode} [${expected.join(', ')}], got [${actual.join(', ')}]`,
        }),
  };
}

export interface JudgeVote {
  label: string;
  score: number;
  reasoning?: string;
}

export interface AggregatedJudgeVote {
  label: string;
  score: number;
  agreement: number;
  votes: JudgeVote[];
}

export function aggregateJudgeVotes(votes: JudgeVote[]): AggregatedJudgeVote {
  if (votes.length === 0) throw new Error('judge panel returned no votes');
  const counts = new Map<string, number>();
  for (const vote of votes) {
    if (!Number.isFinite(vote.score) || vote.score < 0 || vote.score > 1) {
      throw new Error('judge score must be between 0 and 1');
    }
    counts.set(vote.label, (counts.get(vote.label) ?? 0) + 1);
  }
  const ranked = [...counts].sort((left, right) => right[1] - left[1]);
  const winner = ranked[0];
  if (!winner || winner[1] === ranked[1]?.[1]) throw new Error('judge panel tied');
  return {
    label: winner[0],
    score: votes.reduce((sum, vote) => sum + vote.score, 0) / votes.length,
    agreement: winner[1] / votes.length,
    votes: [...votes],
  };
}
