import { describe, expect, it } from 'vitest';
import type { Trace } from '../types';
import {
  aggregateJudgeVotes,
  passAtK,
  passToK,
  scoreTrajectory,
  wilsonInterval,
} from '../evaluation';

function trace(tools: string[]): Trace {
  return {
    id: 'trace',
    suiteId: 'suite',
    taskId: 'task',
    trial: 1,
    agentId: 'agent',
    startedAt: 0,
    events: tools.map((toolName, sequence) => ({
      id: `event-${sequence}`,
      traceId: 'trace',
      sequence,
      timestamp: sequence,
      type: 'tool.requested' as const,
      toolCallId: `call-${sequence}`,
      toolName,
      arguments: {},
      permissionClass: 'read' as const,
    })),
  };
}

describe('agent evaluation statistics', () => {
  it('computes pass@k and pass^k from repeated trials', () => {
    expect(passAtK(10, 3, 2)).toBeCloseTo(0.533333, 5);
    expect(passToK(10, 7, 2)).toBeCloseTo(0.466667, 5);
  });

  it('returns a bounded Wilson confidence interval', () => {
    expect(wilsonInterval(8, 10)).toEqual({
      low: expect.closeTo(0.4902, 3),
      high: expect.closeTo(0.9433, 3),
    });
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
  });
});

describe('trajectory scoring', () => {
  const actual = trace(['search', 'lookup', 'summarize']);

  it.each([
    ['exact', ['search', 'lookup', 'summarize'], true],
    ['in-order', ['search', 'summarize'], false],
    ['subsequence', ['search', 'summarize'], true],
    ['unordered', ['summarize', 'search', 'lookup'], true],
  ] as const)('supports %s matching', (mode, expected, passed) => {
    expect(scoreTrajectory(actual, { mode, tools: [...expected] }).passed).toBe(passed);
  });
});

describe('judge aggregation', () => {
  it('uses majority vote and exposes disagreement', () => {
    const result = aggregateJudgeVotes([
      { label: 'pass', score: 0.9 },
      { label: 'pass', score: 0.8 },
      { label: 'fail', score: 0.2 },
    ]);
    expect(result).toMatchObject({
      label: 'pass',
      score: expect.closeTo(0.6333, 3),
      agreement: expect.closeTo(2 / 3, 3),
    });
  });

  it('fails closed on a tied panel', () => {
    expect(() =>
      aggregateJudgeVotes([
        { label: 'pass', score: 1 },
        { label: 'fail', score: 0 },
      ])
    ).toThrow('judge panel tied');
  });
});
