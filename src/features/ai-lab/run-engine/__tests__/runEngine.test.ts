import { describe, expect, it } from 'vitest';
import { RunEngine } from '../runEngine';

describe('RunEngine', () => {
  it('cancellation wins over a late executor success', async () => {
    let finish!: (value: string) => void;
    const engine = new RunEngine<string>();
    const run = engine.start(
      'agent-suite',
      async () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        })
    );
    engine.cancel(run.jobId);
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
});
