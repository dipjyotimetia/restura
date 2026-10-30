import { describe, expect, it } from 'vitest';
import type { ModelRef, ScorerConfig } from '../../types';
import { sameModelRef, selfJudgingMessage, selfJudgingScorer } from '../judgePolicy';

const A: ModelRef = { providerConfigId: 'p1', model: 'gpt-4o' };
const B: ModelRef = { providerConfigId: 'p1', model: 'gpt-4o-mini' };
const C: ModelRef = { providerConfigId: 'p2', model: 'gpt-4o' };

describe('judgePolicy', () => {
  it('compares model refs by provider config and model id', () => {
    expect(sameModelRef(A, { ...A })).toBe(true);
    expect(sameModelRef(A, B)).toBe(false);
    // Same model id on another provider config is a different endpoint: allowed.
    expect(sameModelRef(A, C)).toBe(false);
  });

  it('finds a judge or pairwise scorer whose judge is a model under test', () => {
    const scorers: ScorerConfig[] = [
      { id: 'c', kind: 'contains', needle: 'x' },
      { id: 'j', kind: 'judge', judgeModel: B, passThreshold: 0.5 },
      { id: 'p', kind: 'pairwise', judgeModel: A, baseline: 'reference', passThreshold: 0.5 },
    ];
    expect(selfJudgingScorer(scorers, [C])).toBeUndefined();
    expect(selfJudgingScorer(scorers, [A])?.id).toBe('p');
    expect(selfJudgingScorer(scorers, [B, C])?.id).toBe('j');
    expect(selfJudgingScorer([], [A])).toBeUndefined();
    expect(selfJudgingMessage(A)).toMatch(/gpt-4o is the model under test/);
  });
});
