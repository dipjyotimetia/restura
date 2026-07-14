import {
  aggregateVerdicts,
  buildJudgeMessages,
  buildJudgeTool,
  JUDGE_TOOL,
  type JudgeCriterion,
  type JudgeVerdict,
  MAX_JUDGE_SAMPLES,
  normalizeCriteria,
  PAIRWISE_TOOL,
  parseJudgment,
  runJudge,
  runPairwiseJudge,
} from '@shared/protocol/ai/judge';
import type { CompletionResult } from '@shared/protocol/ai/types';
import { describe, expect, it } from 'vitest';

function completion(over: Partial<CompletionResult> = {}): CompletionResult {
  return { ok: true, text: '', toolCalls: [], ...over };
}

/** A completion whose tool call returns the per-criterion judge shape. */
function criteriaCompletion(
  entries: Array<{ name: string; score: number; pass: boolean; reasoning?: string }>,
  overallReasoning?: string
): CompletionResult {
  const input = JSON.stringify({
    criteria: entries.map((e) => ({ reasoning: '', ...e })),
    ...(overallReasoning ? { overall_reasoning: overallReasoning } : {}),
  });
  return completion({ toolCalls: [{ id: '1', name: JUDGE_TOOL.name, input }] });
}

describe('buildJudgeMessages', () => {
  it('includes the rubric and ends with the candidate answer', () => {
    const [system, user] = buildJudgeMessages({
      rubric: 'be correct',
      output: 'Paris',
      passThreshold: 0.7,
    });
    expect(system?.role).toBe('system');
    expect(user?.role).toBe('user');
    expect(user?.content).toContain('be correct');
    expect(user?.content).toContain('Candidate answer:\nParis');
    expect(user?.content.trimEnd().endsWith('Evaluate the candidate answer now.')).toBe(true);
  });

  it('includes the reference block when reference is set', () => {
    const [, user] = buildJudgeMessages({
      rubric: 'r',
      output: 'o',
      reference: 'the gold answer',
      passThreshold: 0.7,
    });
    expect(user?.content).toContain('Reference answer:');
    expect(user?.content).toContain('the gold answer');
  });

  it('omits the reference block when reference is not set', () => {
    const [, user] = buildJudgeMessages({
      rubric: 'r',
      output: 'o',
      passThreshold: 0.7,
    });
    expect(user?.content).not.toContain('Reference answer:');
  });

  it('includes a vars block when vars is non-empty', () => {
    const [, user] = buildJudgeMessages({
      rubric: 'r',
      output: 'o',
      vars: { q: 'capital of France?' },
      passThreshold: 0.7,
    });
    expect(user?.content).toContain('Input variables:');
    expect(user?.content).toContain('capital of France?');
  });

  it('omits the vars block when vars is empty or absent', () => {
    const [, user] = buildJudgeMessages({
      rubric: 'r',
      output: 'o',
      vars: {},
      passThreshold: 0.7,
    });
    expect(user?.content).not.toContain('Input variables:');
  });
});

describe('parseJudgment', () => {
  it('reads the JUDGE_TOOL tool call input', () => {
    const r = parseJudgment(
      completion({
        toolCalls: [
          {
            id: '1',
            name: JUDGE_TOOL.name,
            input: '{"score":0.8,"reasoning":"good","pass":true}',
          },
        ],
        text: 'ignored prose',
      }),
      0.7
    );
    expect(r).toEqual({ score: 0.8, reasoning: 'good', pass: true });
  });

  it('falls back to JSON embedded in the completion text', () => {
    const r = parseJudgment(
      completion({ text: 'Verdict: {"score":0.4,"reasoning":"meh","pass":false} done' }),
      0.7
    );
    expect(r.score).toBe(0.4);
    expect(r.reasoning).toBe('meh');
    expect(r.pass).toBe(false);
  });

  it('clamps an out-of-range score to [0,1]', () => {
    const low = parseJudgment(
      completion({
        toolCalls: [
          { id: '1', name: JUDGE_TOOL.name, input: '{"score":-2,"reasoning":"x","pass":false}' },
        ],
      }),
      0.5
    );
    expect(low.score).toBe(0);
    const high = parseJudgment(
      completion({
        toolCalls: [
          { id: '2', name: JUDGE_TOOL.name, input: '{"score":1.5,"reasoning":"x","pass":true}' },
        ],
      }),
      0.5
    );
    expect(high.score).toBe(1);
  });

  it('derives pass from the threshold when pass is absent', () => {
    const r = parseJudgment(
      completion({
        toolCalls: [{ id: '1', name: JUDGE_TOOL.name, input: '{"score":0.95,"reasoning":"x"}' }],
      }),
      0.9
    );
    expect(r.pass).toBe(true); // 0.95 >= 0.9

    const fail = parseJudgment(
      completion({
        toolCalls: [{ id: '2', name: JUDGE_TOOL.name, input: '{"score":0.5,"reasoning":"x"}' }],
      }),
      0.9
    );
    expect(fail.pass).toBe(false); // 0.5 < 0.9
  });

  it('legacy 2-arg form returns exactly {score,reasoning,pass} (no extra keys)', () => {
    const r = parseJudgment(
      completion({
        toolCalls: [
          { id: '1', name: JUDGE_TOOL.name, input: '{"score":0.8,"reasoning":"g","pass":true}' },
        ],
      }),
      0.7
    );
    expect(Object.keys(r).sort()).toEqual(['pass', 'reasoning', 'score']);
  });
});

describe('normalizeCriteria', () => {
  it('wraps a single rubric into one overall criterion', () => {
    expect(normalizeCriteria({ rubric: 'be correct' })).toEqual([
      { name: 'overall', rubric: 'be correct', weight: 1 },
    ]);
  });

  it('passes through explicit criteria untouched', () => {
    const criteria: JudgeCriterion[] = [{ name: 'a', rubric: 'r', weight: 2 }];
    expect(normalizeCriteria({ criteria })).toBe(criteria);
  });
});

describe('buildJudgeMessages (multi-criteria)', () => {
  const criteria: JudgeCriterion[] = [
    { name: 'correctness', rubric: 'is it right', weight: 2 },
    { name: 'no-pii', rubric: 'no personal data', gate: true },
  ];

  it('renders a numbered criteria block with weight and REQUIRED tags', () => {
    const [, user] = buildJudgeMessages({ criteria, output: 'o', passThreshold: 0.6 });
    expect(user?.content).toContain('Criteria:');
    expect(user?.content).toContain('1. correctness (weight 2): is it right');
    expect(user?.content).toContain('2. no-pii (REQUIRED): no personal data');
    expect(user?.content).not.toContain('Rubric:');
  });

  it('includes calibration anchors when provided', () => {
    const [, user] = buildJudgeMessages({
      criteria,
      output: 'o',
      passThreshold: 0.6,
      anchors: [{ output: 'bad answer', score: 0.2, note: 'too short' }],
    });
    expect(user?.content).toContain('Calibration examples');
    expect(user?.content).toContain('score 0.2: bad answer — too short');
  });
});

describe('buildJudgeTool', () => {
  it('produces a per-criterion array schema under the submit_judgment name', () => {
    const tool = buildJudgeTool([{ name: 'a', rubric: 'r' }]);
    expect(tool.name).toBe(JUDGE_TOOL.name);
    expect(tool.inputSchema.properties.criteria.type).toBe('array');
    expect(tool.inputSchema.required).toContain('criteria');
  });
});

describe('parseJudgment (multi-criteria)', () => {
  const criteria: JudgeCriterion[] = [
    { name: 'correctness', rubric: 'r', weight: 3 },
    { name: 'tone', rubric: 'r', weight: 1 },
  ];

  it('computes a weighted aggregate score', () => {
    const v = parseJudgment(
      criteriaCompletion([
        { name: 'correctness', score: 1, pass: true },
        { name: 'tone', score: 0, pass: false },
      ]),
      0.5,
      criteria
    );
    // (1*3 + 0*1) / 4 = 0.75
    expect(v.score).toBeCloseTo(0.75);
    expect(v.perCriterion).toHaveLength(2);
  });

  it('a failing gate criterion fails the verdict despite a high weighted score', () => {
    const gated: JudgeCriterion[] = [
      { name: 'quality', rubric: 'r', weight: 5 },
      { name: 'safety', rubric: 'r', gate: true },
    ];
    const v = parseJudgment(
      criteriaCompletion([
        { name: 'quality', score: 1, pass: true },
        { name: 'safety', score: 0.1, pass: false },
      ]),
      0.5,
      gated
    );
    expect(v.score).toBeGreaterThan(0.5); // weighted score clears the bar
    expect(v.pass).toBe(false); // ...but the gate fails it
  });

  it('falls back to a flat {score,pass} shape applied across criteria', () => {
    const flat = completion({
      toolCalls: [
        { id: '1', name: JUDGE_TOOL.name, input: '{"score":0.9,"pass":true,"reasoning":"x"}' },
      ],
    });
    const v = parseJudgment(flat, 0.5, [{ name: 'overall', rubric: 'r' }]);
    expect(v.score).toBeCloseTo(0.9);
    expect(v.pass).toBe(true);
  });
});

describe('aggregateVerdicts', () => {
  const criteria: JudgeCriterion[] = [{ name: 'overall', rubric: 'r', weight: 1 }];
  const v = (score: number, pass: boolean): JudgeVerdict => ({
    score,
    pass,
    reasoning: '',
    perCriterion: [{ name: 'overall', score, pass, reasoning: `r${score}` }],
  });

  it('returns a single verdict unchanged but stamped with samples=1, variance=0', () => {
    const out = aggregateVerdicts([v(0.8, true)], criteria, 0.5);
    expect(out.score).toBeCloseTo(0.8);
    expect(out.samples).toBe(1);
    expect(out.variance).toBe(0);
  });

  it('takes the median score and reports variance across samples', () => {
    const out = aggregateVerdicts([v(0.2, false), v(0.6, true), v(0.7, true)], criteria, 0.5);
    expect(out.score).toBeCloseTo(0.6); // median of [0.2,0.6,0.7]
    expect(out.pass).toBe(true); // 0.6 >= 0.5
    expect(out.samples).toBe(3);
    expect(out.variance).toBeGreaterThan(0);
  });
});

describe('runJudge', () => {
  it('samples N times and aggregates', async () => {
    const scores = [0.2, 0.8, 0.6];
    let i = 0;
    const complete = async () =>
      criteriaCompletion([{ name: 'overall', score: scores[i++]!, pass: true }]);
    const v = await runJudge(
      { output: 'o', rubric: 'r', samples: 3, passThreshold: 0.5 },
      complete
    );
    expect(v.samples).toBe(3);
    expect(v.score).toBeCloseTo(0.6); // median
  });

  it('clamps samples to MAX_JUDGE_SAMPLES', async () => {
    let calls = 0;
    const complete = async () => {
      calls++;
      return criteriaCompletion([{ name: 'overall', score: 0.9, pass: true }]);
    };
    await runJudge({ output: 'o', rubric: 'r', samples: 99, passThreshold: 0.5 }, complete);
    expect(calls).toBe(MAX_JUDGE_SAMPLES);
  });

  it('throws when a sample completion fails', async () => {
    const complete = async () =>
      completion({ ok: false, error: { code: 'provider', message: 'rate limited' } });
    await expect(
      runJudge({ output: 'o', rubric: 'r', passThreshold: 0.5 }, complete)
    ).rejects.toThrow('rate limited');
  });
});

describe('runPairwiseJudge', () => {
  const comparison = (winner: 'A' | 'B' | 'tie') =>
    completion({
      toolCalls: [
        { id: '1', name: PAIRWISE_TOOL.name, input: JSON.stringify({ winner, reasoning: 'r' }) },
      ],
    });

  it('reports A as winner with score 1', async () => {
    const complete = async () => comparison('A');
    const v = await runPairwiseJudge({ outputA: 'a', outputB: 'b' }, complete);
    expect(v.winner).toBe('A');
    expect(v.score).toBe(1);
  });

  it('reports B as winner with score 0', async () => {
    const complete = async () => comparison('B');
    const v = await runPairwiseJudge({ outputA: 'a', outputB: 'b' }, complete);
    expect(v.winner).toBe('B');
    expect(v.score).toBe(0);
  });

  it('keeps a consistent winner across swapped orderings', async () => {
    // First call (A,B) → A wins. Swapped call (B,A) → "B wins" (i.e. original A).
    const responses = [comparison('A'), comparison('B')];
    let i = 0;
    const complete = async () => responses[i++]!;
    const v = await runPairwiseJudge({ outputA: 'a', outputB: 'b', swapPositions: true }, complete);
    expect(v.winner).toBe('A');
    expect(v.swapped).toBeUndefined();
  });

  it('collapses to a tie when orderings disagree (position bias)', async () => {
    // Both calls say "A wins" → in original frame that's A then B → disagreement.
    const complete = async () => comparison('A');
    const v = await runPairwiseJudge({ outputA: 'a', outputB: 'b', swapPositions: true }, complete);
    expect(v.winner).toBe('tie');
    expect(v.swapped).toBe(true);
    expect(v.score).toBe(0.5);
  });
});
