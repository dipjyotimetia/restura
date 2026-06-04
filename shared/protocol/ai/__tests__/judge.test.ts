import { describe, it, expect } from 'vitest';
import { buildJudgeMessages, parseJudgment, JUDGE_TOOL } from '@shared/protocol/ai/judge';
import type { CompletionResult } from '@shared/protocol/ai/types';

function completion(over: Partial<CompletionResult> = {}): CompletionResult {
  return { ok: true, text: '', toolCalls: [], ...over };
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
});
