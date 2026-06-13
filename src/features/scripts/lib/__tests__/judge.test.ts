import { describe, it, expect, vi } from 'vitest';
import ScriptExecutor from '../scriptExecutor';
import type { JudgeRequestInput, JudgeVerdict } from '@shared/protocol/ai/judge';

/**
 * rs.judge — LLM-as-judge host bridge contract.
 *
 * `rs.judge(output, opts)` MUST be async (return a promise resolving to a
 * verdict `{ pass, score, reasoning }`). The executor wraps `host.judge`
 * with a QuickJS deferred promise (same machinery as pm.vault), so a user
 * can `await` it inside a test script. If no `host.judge` is wired in, the
 * call rejects with a clean message rather than hanging.
 */

function passingJudge(verdict: Partial<JudgeVerdict> = {}) {
  return vi.fn(
    async (_input: JudgeRequestInput): Promise<JudgeVerdict> => ({
      pass: true,
      score: 0.9,
      reasoning: 'good',
      ...verdict,
    })
  );
}

describe('rs.judge — host bridge', () => {
  it('await rs.judge resolves a verdict and forwards output + rubric', async () => {
    const judge = passingJudge();
    const ex = new ScriptExecutor({ host: { judge } });
    const r = await ex.executeScript(
      `
      (async function () {
        const v = await rs.judge(response.body, { rubric: 'Answers correctly' });
        pm.test('answer is correct', function () {
          pm.expect(v.pass).to.be.true;
          pm.expect(v.score).to.equal(0.9);
        });
      })();
    `,
      {
        response: {
          status: 200,
          statusText: 'OK',
          headers: {},
          body: 'Paris is the capital of France.',
          time: 5,
          size: 30,
        },
      }
    );
    expect(r.tests?.every((t) => t.passed)).toBe(true);
    expect(judge).toHaveBeenCalledTimes(1);
    const input = judge.mock.calls[0]![0];
    expect(input.output).toBe('Paris is the capital of France.');
    expect(input.rubric).toBe('Answers correctly');
  });

  it('a false verdict propagates — assertions on v.pass fail accordingly', async () => {
    const judge = passingJudge({ pass: false, score: 0.1, reasoning: 'wrong' });
    const ex = new ScriptExecutor({ host: { judge } });
    const r = await ex.executeScript(
      `
      (async function () {
        const v = await rs.judge('nope', { rubric: 'x' });
        pm.test('should pass', function () { pm.expect(v.pass).to.be.true; });
      })();
    `,
      {}
    );
    expect(r.tests?.find((t) => t.name === 'should pass')?.passed).toBe(false);
  });

  it('forwards reference and passThreshold into the JudgeRequestInput', async () => {
    const judge = passingJudge();
    const ex = new ScriptExecutor({ host: { judge } });
    await ex.executeScript(
      `
      (async function () {
        await rs.judge('candidate', { rubric: 'r', reference: 'gold', passThreshold: 0.8 });
      })();
    `,
      {}
    );
    const input = judge.mock.calls[0]![0];
    expect(input.reference).toBe('gold');
    expect(input.passThreshold).toBe(0.8);
  });

  it('forwards multi-criteria, samples, and anchors into the JudgeRequestInput', async () => {
    const judge = passingJudge();
    const ex = new ScriptExecutor({ host: { judge } });
    await ex.executeScript(
      `
      (async function () {
        await rs.judge('candidate', {
          criteria: [{ name: 'correctness', rubric: 'right?', weight: 2, gate: true }],
          samples: 3,
          anchors: [{ output: 'bad', score: 0.1, note: 'too short' }],
        });
      })();
    `,
      {}
    );
    const input = judge.mock.calls[0]![0];
    expect(input.criteria).toEqual([
      { name: 'correctness', rubric: 'right?', weight: 2, gate: true },
    ]);
    expect(input.samples).toBe(3);
    expect(input.anchors).toEqual([{ output: 'bad', score: 0.1, note: 'too short' }]);
  });

  it('no host.judge wired: rs.judge rejects with a clean message', async () => {
    const ex = new ScriptExecutor({});
    const r = await ex.executeScript(
      `
      (async function () {
        try {
          await rs.judge('x', { rubric: 'r' });
          pm.test('unreachable', function () { pm.expect.fail('should have thrown'); });
        } catch (e) {
          pm.test('rejected', function () {
            pm.expect(String(e.message)).to.match(/not wired in/);
          });
        }
      })();
    `,
      {}
    );
    expect(r.tests?.every((t) => t.passed)).toBe(true);
  });

  it('host rejection surfaces as a thrown error inside await', async () => {
    const judge = vi.fn(async (_input: JudgeRequestInput): Promise<JudgeVerdict> => {
      throw new Error('judge provider unreachable');
    });
    const ex = new ScriptExecutor({ host: { judge } });
    const r = await ex.executeScript(
      `
      (async function () {
        try {
          await rs.judge('x', { rubric: 'r' });
          pm.test('unreachable', function () { pm.expect.fail('should have thrown'); });
        } catch (e) {
          pm.test('caught', function () {
            pm.expect(String(e.message)).to.match(/judge provider unreachable/);
          });
        }
      })();
    `,
      {}
    );
    expect(judge).toHaveBeenCalledTimes(1);
    expect(r.tests?.every((t) => t.passed)).toBe(true);
  });
});
