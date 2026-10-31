// Eval-design rules the judge scorers must follow, shared by the runner (fail
// closed per cell) and the builder (refuse to start). A judge that is the model
// under test grades its own output, which inflates agreement and hides the
// failure modes both share; Anthropic's eval guidance is that the judge model
// should never be the model under test.
import type { ModelRef, ScorerConfig } from './types';

export function sameModelRef(a: ModelRef, b: ModelRef): boolean {
  return a.providerConfigId === b.providerConfigId && a.model === b.model;
}

/** Error text for a judge call refused because the judge is the model under test. */
export function selfJudgingMessage(judgeModel: ModelRef): string {
  return `judge model ${judgeModel.model} is the model under test; pick a different judge`;
}

/**
 * The first judge or pairwise scorer whose judge model is one of the models
 * under test, or undefined. Checked before a run starts (the builder) so the
 * refusal is one message, not a per-cell error.
 */
export function selfJudgingScorer(
  scorers: readonly ScorerConfig[],
  modelsUnderTest: readonly ModelRef[]
): Extract<ScorerConfig, { kind: 'judge' | 'pairwise' }> | undefined {
  for (const scorer of scorers) {
    if (scorer.kind !== 'judge' && scorer.kind !== 'pairwise') continue;
    if (modelsUnderTest.some((m) => sameModelRef(m, scorer.judgeModel))) return scorer;
  }
  return undefined;
}
