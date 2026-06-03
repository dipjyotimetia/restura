import { describe, it, expect } from 'vitest';
import { parseJudgment, buildJudgeMessages } from '../judgePrompt';
import type { CompletionResult } from '@shared/protocol/ai/types';

function completion(over: Partial<CompletionResult> = {}): CompletionResult {
  return { ok: true, text: '', toolCalls: [], ...over };
}

describe('parseJudgment', () => {
  it('prefers the structured tool call', () => {
    const r = parseJudgment(
      completion({
        toolCalls: [
          {
            id: '1',
            name: 'submit_judgment',
            input: '{"score":0.8,"reasoning":"good","pass":true}',
          },
        ],
        text: 'ignored prose',
      }),
      0.7
    );
    expect(r).toEqual({ score: 0.8, reasoning: 'good', pass: true });
  });

  it('falls back to JSON embedded in the text body', () => {
    const r = parseJudgment(
      completion({ text: 'Here is my verdict: {"score":0.4,"reasoning":"meh","pass":false} done' }),
      0.7
    );
    expect(r.score).toBe(0.4);
    expect(r.pass).toBe(false);
  });

  it('clamps the score and derives pass from threshold when omitted', () => {
    const r = parseJudgment(
      completion({
        toolCalls: [{ id: '1', name: 'submit_judgment', input: '{"score":1.5,"reasoning":"x"}' }],
      }),
      0.9
    );
    expect(r.score).toBe(1);
    expect(r.pass).toBe(true); // 1 >= 0.9
  });

  it('returns a zero verdict on unparseable output', () => {
    const r = parseJudgment(completion({ text: 'no json here' }), 0.5);
    expect(r.score).toBe(0);
    expect(r.pass).toBe(false);
  });
});

describe('buildJudgeMessages', () => {
  it('includes the rubric, candidate answer, and reference', () => {
    const [system, user] = buildJudgeMessages({
      rubric: 'be correct',
      output: 'Paris',
      testCase: { id: 'c', vars: { q: 'capital?' }, reference: 'Paris' },
      passThreshold: 0.7,
    });
    expect(system?.role).toBe('system');
    expect(user?.content).toContain('be correct');
    expect(user?.content).toContain('Paris');
    expect(user?.content).toContain('Reference answer');
  });
});
