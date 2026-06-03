import { describe, it, expect } from 'vitest';
import { runScriptScorer } from '../evalRunner';

// Exercises the REAL QuickJS sandbox path (not a mock): the completion is
// wrapped as a synthetic { status:200, body: output } response so existing
// pm.test / pm.response assertions work unchanged.
describe('runScriptScorer (QuickJS, synthetic response)', () => {
  it('passes when a pm.test asserting the synthetic 200 status succeeds', async () => {
    const res = await runScriptScorer({
      code: "pm.test('status ok', () => pm.response.to.have.status(200));",
      output: 'anything',
      latencyMs: 12,
    });
    expect(res.passed).toBe(true);
    expect(res.failures).toEqual([]);
  });

  it('exposes the model output via pm.response.text() for content assertions', async () => {
    const res = await runScriptScorer({
      code: "pm.test('says paris', () => pm.expect(pm.response.text()).to.include('Paris'));",
      output: 'Paris is the capital',
      latencyMs: 5,
    });
    expect(res.passed).toBe(true);
  });

  it('fails and reports the failing test name when an assertion does not hold', async () => {
    const res = await runScriptScorer({
      code: "pm.test('wrong status', () => pm.response.to.have.status(404));",
      output: 'x',
      latencyMs: 5,
    });
    expect(res.passed).toBe(false);
    expect(res.failures.join(' ')).toMatch(/wrong status/);
  });

  it('does not pass when the script registers no tests', async () => {
    const res = await runScriptScorer({ code: 'const x = 1;', output: 'x', latencyMs: 5 });
    expect(res.passed).toBe(false);
  });

  it("the EvalBuilder default 'script' snippet passes on non-empty output", async () => {
    // Keep in sync with defaultScorer('script') in EvalBuilder.tsx.
    const res = await runScriptScorer({
      code: "pm.test('non-empty', () => pm.expect(pm.response.text().length).to.be.above(0));",
      output: 'some answer',
      latencyMs: 5,
    });
    expect(res.passed).toBe(true);
  });
});
