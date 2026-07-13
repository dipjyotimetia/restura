import { describe, expect, it } from 'vitest';
import { RunEngine } from '../runEngine';

describe('RunEngine', () => {
  it('cancellation wins over a late executor success', async () => {
    let finish!: (value: string) => void;
    let executorSignal!: AbortSignal;
    const engine = new RunEngine<string>();
    const run = engine.start(
      'agent-suite',
      async ({ signal }) =>
        new Promise<string>((resolve) => {
          executorSignal = signal;
          finish = resolve;
        })
    );

    expect(engine.cancel(run.jobId)).toBe(true);
    expect(engine.get(run.jobId)?.status).toBe('cancelling');
    expect(executorSignal.aborted).toBe(true);

    finish('late success');
    await expect(run.result).rejects.toMatchObject({ name: 'AbortError' });
    expect(engine.get(run.jobId)?.status).toBe('cancelled');
  });

  it('bounds progress and preserves structured failures', async () => {
    const engine = new RunEngine<string>();
    const run = engine.start('eval', async ({ reportProgress }) => {
      reportProgress(2);
      throw new Error('provider unavailable');
    });
    await expect(run.result).rejects.toThrow('provider unavailable');
    expect(engine.get(run.jobId)).toMatchObject({
      status: 'error',
      progress: 1,
      failure: { message: 'provider unavailable', at: expect.any(Number) },
    });
  });

  it.each([
    ['negative progress', -1, 0],
    ['NaN progress', Number.NaN, 0],
  ])('normalizes %s into the progress range', async (_label, progress, expected) => {
    const engine = new RunEngine<string>();
    let observedProgress: number | undefined;
    const run = engine.start('eval', async ({ jobId, reportProgress }) => {
      reportProgress(progress);
      observedProgress = engine.get(jobId)?.progress;
      return 'done';
    });

    await expect(run.result).resolves.toBe('done');
    expect(observedProgress).toBe(expected);
  });
});
