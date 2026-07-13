import type { RunExecutorContext, RunJobSnapshot, RunKind, RunStatus } from './types';

interface InternalJob<Result> extends RunJobSnapshot<Result> {
  controller: AbortController;
}

type RunExecutor<Result> = (context: RunExecutorContext) => Promise<Result>;

export class RunEngine<Result> {
  private readonly jobs = new Map<string, InternalJob<Result>>();

  start(kind: RunKind, executor: RunExecutor<Result>): { jobId: string; result: Promise<Result> } {
    const jobId = crypto.randomUUID();
    const controller = new AbortController();
    const job = createInternalJob<Result>(jobId, kind, controller);
    this.jobs.set(jobId, job);

    return { jobId, result: this.execute(job, executor) };
  }

  get(jobId: string): RunJobSnapshot<Result> | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;

    const { controller: _controller, ...snapshot } = job;
    return { ...snapshot };
  }

  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || isTerminal(job.status)) return false;

    job.status = 'cancelling';
    job.controller.abort(new DOMException('Run cancelled', 'AbortError'));
    return true;
  }

  private async execute(job: InternalJob<Result>, executor: RunExecutor<Result>): Promise<Result> {
    job.status = 'running';

    try {
      const result = await executor({
        jobId: job.jobId,
        signal: job.controller.signal,
        reportProgress: (progress) => {
          if (!isTerminal(job.status)) job.progress = clampProgress(progress);
        },
      });

      if (job.controller.signal.aborted) {
        markCancelled(job);
        throw abortReason(job.controller.signal);
      }

      job.status = 'passed';
      job.progress = 1;
      job.result = result;
      job.finishedAt = Date.now();
      return result;
    } catch (error) {
      if (job.controller.signal.aborted || isAbortError(error)) {
        markCancelled(job);
        throw job.controller.signal.aborted ? abortReason(job.controller.signal) : error;
      }

      job.status = 'error';
      job.failure = { message: errorMessage(error), at: Date.now() };
      job.finishedAt = Date.now();
      throw error;
    }
  }
}

function createInternalJob<Result>(
  jobId: string,
  kind: RunKind,
  controller: AbortController
): InternalJob<Result> {
  return {
    jobId,
    kind,
    status: 'queued',
    progress: 0,
    startedAt: Date.now(),
    controller,
  };
}

function isTerminal(status: RunStatus): boolean {
  return ['passed', 'failed', 'error', 'cancelled'].includes(status);
}

function clampProgress(progress: number): number {
  if (Number.isNaN(progress)) return 0;
  return Math.min(1, Math.max(0, progress));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Run cancelled', 'AbortError');
}

function markCancelled<Result>(job: InternalJob<Result>): void {
  job.status = 'cancelled';
  job.finishedAt = Date.now();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
