import { describe, expect, it } from 'vitest';
import type { EvalCellResult, EvalRun, ScoreResult } from '../../types';
import { judgeStats } from '../ReportView';

function cell(scores: ScoreResult[]): EvalCellResult {
  return {
    caseId: 'c',
    modelRef: { providerConfigId: 'p', model: 'm' },
    output: '',
    ok: true,
    latencyMs: 10,
    cost: 0,
    scores,
    passed: scores.every((s) => s.passed),
  };
}

function run(cells: EvalCellResult[]): EvalRun {
  return {
    id: 'r',
    evalConfigId: 'e',
    configName: 'x',
    startedAt: 0,
    status: 'done',
    totalCells: cells.length,
    cells,
  };
}

describe('judgeStats', () => {
  it('aggregates per-criterion pass rates and averages variance only over sampled cells', () => {
    const stats = judgeStats(
      run([
        cell([
          {
            scorerId: 'j',
            kind: 'judge',
            passed: true,
            score: 0.8,
            variance: 0.02,
            perCriterion: [
              { name: 'correctness', score: 0.8, pass: true, reasoning: '' },
              { name: 'safety', score: 0.9, pass: true, reasoning: '' },
            ],
          },
        ]),
        cell([
          {
            scorerId: 'j',
            kind: 'judge',
            passed: false,
            score: 0.4,
            // no variance (samples = 1)
            perCriterion: [
              { name: 'correctness', score: 0.4, pass: false, reasoning: '' },
              { name: 'safety', score: 0.9, pass: true, reasoning: '' },
            ],
          },
        ]),
      ])
    );

    expect(stats.judged).toBe(2);
    expect(stats.avgVariance).toBe(0.02); // only one of the two cells reported variance
    expect(stats.criteria.find((c) => c.name === 'correctness')).toMatchObject({
      passed: 1,
      total: 2,
    });
    expect(stats.criteria.find((c) => c.name === 'safety')).toMatchObject({ passed: 2, total: 2 });
  });

  it('ignores non-judge scores and returns empty stats when there are none', () => {
    const stats = judgeStats(run([cell([{ scorerId: 'r', kind: 'regex', passed: true }])]));
    expect(stats.judged).toBe(0);
    expect(stats.avgVariance).toBeNull();
    expect(stats.criteria).toEqual([]);
  });
});
