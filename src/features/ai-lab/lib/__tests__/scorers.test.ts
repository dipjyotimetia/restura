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

describe('tool-call scorer', () => {
  const toolCall = (name: string, input: string) => ({ id: '1', name, input });

  it('fails when the model made no tool call', async () => {
    const s: ScorerConfig = { id: 's', kind: 'tool-call', expectedTool: 'do_thing' };
    const r = await runScorer(s, ctx({ toolCalls: [] }));
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/no tool call/);
  });

  it('passes when the expected tool was called', async () => {
    const s: ScorerConfig = { id: 's', kind: 'tool-call', expectedTool: 'do_thing' };
    const r = await runScorer(s, ctx({ toolCalls: [toolCall('do_thing', '{"x":1}')] }));
    expect(r.passed).toBe(true);
  });

  it('fails when a different tool was called', async () => {
    const s: ScorerConfig = { id: 's', kind: 'tool-call', expectedTool: 'do_thing' };
    const r = await runScorer(s, ctx({ toolCalls: [toolCall('other', '{}')] }));
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/not called/);
  });

  it('validates args against a JSON schema', async () => {
    const s: ScorerConfig = {
      id: 's',
      kind: 'tool-call',
      expectedTool: 'req',
      argsSchema: JSON.stringify({ type: 'object', required: ['url'] }),
    };
    expect((await runScorer(s, ctx({ toolCalls: [toolCall('req', '{"url":"x"}')] }))).passed).toBe(
      true
    );
    expect((await runScorer(s, ctx({ toolCalls: [toolCall('req', '{"q":1}')] }))).passed).toBe(
      false
    );
  });

  it('matches args against the case expected (order-insensitive)', async () => {
    const s: ScorerConfig = {
      id: 's',
      kind: 'tool-call',
      expectedTool: 'req',
      expectedArgsFrom: 'expected',
    };
    const c: DatasetCase = { id: 'c', vars: {}, expected: '{"a":1,"b":2}' };
    const ok = await runScorer(s, {
      ...ctx(),
      testCase: c,
      toolCalls: [toolCall('req', '{"b":2,"a":1}')],
    });
    expect(ok.passed).toBe(true);
    const bad = await runScorer(s, {
      ...ctx(),
      testCase: c,
      toolCalls: [toolCall('req', '{"a":9}')],
    });
    expect(bad.passed).toBe(false);
  });
});

describe('pairwise scorer (injected)', () => {
  it('passes when the cell output wins above threshold', async () => {
    const pairwise = vi.fn(async () => ({ winner: 'A' as const, score: 1, reasoning: 'A better' }));
    const s: ScorerConfig = {
      id: 's',
      kind: 'pairwise',
      judgeModel: { providerConfigId: 'p1', model: 'm' },
      baseline: 'reference',
      passThreshold: 0.5,
    };
    const r = await runScorer(s, ctx({ pairwise }));
    expect(pairwise).toHaveBeenCalledOnce();
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
  });

  it('fails when there is no baseline to compare against', async () => {
    const pairwise = vi.fn(async () => ({ winner: 'A' as const, score: 1, reasoning: '' }));
    const s: ScorerConfig = {
      id: 's',
      kind: 'pairwise',
      judgeModel: { providerConfigId: 'p1', model: 'm' },
      baseline: 'reference',
      passThreshold: 0.5,
    };
    const noRef: DatasetCase = { id: 'c', vars: {} };
    const r = await runScorer(s, { ...ctx({ pairwise }), testCase: noRef });
    expect(r.passed).toBe(false);
    expect(pairwise).not.toHaveBeenCalled();
  });
});

describe('json-schema scorer error handling', () => {
  it('fails closed on a malformed scorer schema', async () => {
    const s: ScorerConfig = { id: 's', kind: 'json-schema', schema: 'not json' };
    const r = await runScorer(s, ctx({ output: '{"a":1}' }));
    expect(r.passed).toBe(false);
  });
});
