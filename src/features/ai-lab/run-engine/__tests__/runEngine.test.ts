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

  it('exposes a transformed cancellation result while keeping cancellation terminal', async () => {
    let finish!: (value: { status: 'passed' | 'cancelled'; trace: string[] }) => void;
    const engine = new RunEngine<{ status: 'passed' | 'cancelled'; trace: string[] }>();
    const run = engine.start('agent-suite', () => new Promise((resolve) => (finish = resolve)), {
      cancellationResult: (result) => ({ ...result, status: 'cancelled' }),
      classifyResult: (result) => result.status,
    });

    engine.cancel(run.jobId);
    finish({ status: 'passed', trace: ['partial resource'] });

    await expect(run.result).rejects.toMatchObject({
      name: 'AbortError',
      result: { status: 'cancelled', trace: ['partial resource'] },
    });
    expect(engine.get(run.jobId)).toMatchObject({
      status: 'cancelled',
      result: { status: 'cancelled', trace: ['partial resource'] },
    });
  });

  it.each([
    'failed',
    'error',
  ] as const)('classifies a normally resolved %s domain outcome without calling it passed', async (status) => {
    const engine = new RunEngine<{ status: 'passed' | 'failed' | 'error' }>();
    const run = engine.start('agent-suite', async () => ({ status }), {
      classifyResult: (result) => result.status,
    });

    await expect(run.result).resolves.toEqual({ status });
    expect(engine.get(run.jobId)?.status).toBe(status);
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

  it('releases terminal snapshots and their retained results explicitly', async () => {
    const engine = new RunEngine<{ payload: string }>();
    const run = engine.start('eval', async () => ({ payload: 'large raw result' }));
    await run.result;

    expect(engine.get(run.jobId)?.result).toEqual({ payload: 'large raw result' });
    expect(engine.release(run.jobId)).toBe(true);
    expect(engine.get(run.jobId)).toBeUndefined();
    expect(engine.release(run.jobId)).toBe(false);
  });

  it('does not release active jobs or interfere with active cancellation', async () => {
    let finish!: () => void;
    const engine = new RunEngine<void>();
    const run = engine.start(
      'agent-suite',
      () => new Promise<void>((resolve) => (finish = resolve))
    );

    expect(engine.release(run.jobId)).toBe(false);
    expect(engine.cancel(run.jobId)).toBe(true);
    finish();
    await expect(run.result).rejects.toMatchObject({ name: 'AbortError' });
    expect(engine.release(run.jobId)).toBe(true);
  });

  it('keeps repeated completed runs bounded when callers release consumed snapshots', async () => {
    const engine = new RunEngine<string>();
    for (let index = 0; index < 100; index += 1) {
      const run = engine.start('eval', async () => `result-${index}`);
      await run.result;
      expect(engine.release(run.jobId)).toBe(true);
    }

    expect(engine.retainedJobCount).toBe(0);
  });
});
