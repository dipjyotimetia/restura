import { describe, it, expect, vi } from 'vitest';
import type { JudgeRequestInput, JudgeVerdict } from '@shared/protocol/ai/judge';
import { runScorer, type ScorerContext } from '../scorers';
import type { DatasetCase, ModelRef, ScorerConfig } from '../../types';

const CASE: DatasetCase = {
  id: 'c1',
  vars: { q: 'hi' },
  expected: 'Paris',
  reference: 'Paris is the capital',
};

function ctx(over: Partial<ScorerContext> = {}): ScorerContext {
  return { output: 'Paris', testCase: CASE, latencyMs: 100, cost: 0.001, ...over };
}

describe('deterministic scorers', () => {
  it('exact-match against expected (case-insensitive)', async () => {
    const s: ScorerConfig = {
      id: 's',
      kind: 'exact-match',
      expectedFrom: 'expected',
      caseInsensitive: true,
    };
    expect((await runScorer(s, ctx({ output: 'PARIS' }))).passed).toBe(true);
    expect((await runScorer(s, ctx({ output: 'London' }))).passed).toBe(false);
  });

  it('contains', async () => {
    const s: ScorerConfig = { id: 's', kind: 'contains', needle: 'cap', caseInsensitive: true };
    expect((await runScorer(s, ctx({ output: 'The Capital' }))).passed).toBe(true);
  });

  it('regex', async () => {
    const s: ScorerConfig = { id: 's', kind: 'regex', pattern: '^Par' };
    expect((await runScorer(s, ctx())).passed).toBe(true);
  });

  it('invalid regex fails gracefully with detail', async () => {
    const s: ScorerConfig = { id: 's', kind: 'regex', pattern: '(' };
    const r = await runScorer(s, ctx());
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/invalid regex/);
  });

  it('json-valid', async () => {
    const s: ScorerConfig = { id: 's', kind: 'json-valid' };
    expect((await runScorer(s, ctx({ output: '{"a":1}' }))).passed).toBe(true);
    expect((await runScorer(s, ctx({ output: 'nope' }))).passed).toBe(false);
  });

  it('json-schema validates structure via Ajv', async () => {
    const s: ScorerConfig = {
      id: 's',
      kind: 'json-schema',
      schema: JSON.stringify({
        type: 'object',
        properties: { a: { type: 'number' } },
        required: ['a'],
      }),
    };
    expect((await runScorer(s, ctx({ output: '{"a":1}' }))).passed).toBe(true);
    expect((await runScorer(s, ctx({ output: '{"a":"x"}' }))).passed).toBe(false);
  });

  it('latency threshold', async () => {
    const s: ScorerConfig = { id: 's', kind: 'latency', maxMs: 500 };
    expect((await runScorer(s, ctx({ latencyMs: 200 }))).passed).toBe(true);
    expect((await runScorer(s, ctx({ latencyMs: 900 }))).passed).toBe(false);
  });

  it('cost threshold fails when cost is unknown (null)', async () => {
    const s: ScorerConfig = { id: 's', kind: 'cost', maxUSD: 0.01 };
    expect((await runScorer(s, ctx({ cost: 0.005 }))).passed).toBe(true);
    const unknown = await runScorer(s, ctx({ cost: null }));
    expect(unknown.passed).toBe(false);
    expect(unknown.detail).toMatch(/unknown/);
  });
});

describe('judge scorer (structured, injected)', () => {
  it('passes through the injected judge verdict and score', async () => {
    const judge = vi.fn(async () => ({ score: 0.9, reasoning: 'good', pass: true }));
    const s: ScorerConfig = {
      id: 's',
      kind: 'judge',
      judgeModel: { providerConfigId: 'p1', model: 'gpt-4o' },
      rubric: 'is it correct',
      passThreshold: 0.7,
    };
    const r = await runScorer(s, ctx({ judge }));
    expect(judge).toHaveBeenCalledOnce();
    expect(r.passed).toBe(true);
    expect(r.score).toBe(0.9);
  });

  it('fails closed when no judge runner is available', async () => {
    const s: ScorerConfig = {
      id: 's',
      kind: 'judge',
      judgeModel: { providerConfigId: 'p1', model: 'm' },
      rubric: 'r',
      passThreshold: 0.5,
    };
    expect((await runScorer(s, ctx())).passed).toBe(false);
  });

  it('forwards criteria/samples/anchors (+ case reference/vars) and maps perCriterion/variance', async () => {
    const judge = vi.fn(
      async (_a: { judgeModel: ModelRef; input: JudgeRequestInput }): Promise<JudgeVerdict> => ({
        score: 0.8,
        reasoning: 'ok',
        pass: true,
        perCriterion: [{ name: 'correctness', score: 0.8, pass: true, reasoning: 'ok' }],
        variance: 0.01,
      })
    );
    const s: ScorerConfig = {
      id: 's',
      kind: 'judge',
      judgeModel: { providerConfigId: 'p1', model: 'm' },
      passThreshold: 0.6,
      criteria: [{ name: 'correctness', rubric: 'is it correct', weight: 2 }],
      samples: 3,
      anchors: [{ output: 'bad', score: 0.1 }],
    };
    const r = await runScorer(s, ctx({ judge }));
    const input = judge.mock.calls[0]![0].input;
    expect(input.criteria).toEqual([{ name: 'correctness', rubric: 'is it correct', weight: 2 }]);
    expect(input.samples).toBe(3);
    expect(input.anchors).toEqual([{ output: 'bad', score: 0.1 }]);
    expect(input.reference).toBe(CASE.reference);
    expect(input.vars).toEqual(CASE.vars);
    expect(r.perCriterion).toHaveLength(1);
    expect(r.variance).toBe(0.01);
  });
});
