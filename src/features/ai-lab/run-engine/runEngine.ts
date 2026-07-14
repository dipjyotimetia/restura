import type { RunExecutorContext, RunJobSnapshot, RunKind, RunStatus } from './types';

interface InternalJob<Result> extends RunJobSnapshot<Result> {
  controller: AbortController;
}

type RunExecutor<Result> = (context: RunExecutorContext) => Promise<Result>;
type RunOutcomeStatus = Extract<RunStatus, 'passed' | 'failed' | 'error' | 'cancelled'>;

interface RunOptions<Result> {
  classifyResult?(result: Result): RunOutcomeStatus;
  cancellationResult?(result: Result): Result;
}

export class RunCancelledWithResultError<Result> extends Error {
  readonly result: Result;

  constructor(result: Result) {
    super('Run cancelled');
    this.name = 'AbortError';
    this.result = result;
  }
}

export function isRunCancelledWithResult<Result>(
  cause: unknown
): cause is RunCancelledWithResultError<Result> {
  return cause instanceof RunCancelledWithResultError;
}

export class RunEngine<Result> {
  private readonly jobs = new Map<string, InternalJob<Result>>();

  start(
    kind: RunKind,
    executor: RunExecutor<Result>,
    options: RunOptions<Result> = {}
  ): { jobId: string; result: Promise<Result> } {
    const jobId = crypto.randomUUID();
    const controller = new AbortController();
    const job = createInternalJob<Result>(jobId, kind, controller);
    this.jobs.set(jobId, job);

    return { jobId, result: this.execute(job, executor, options) };
  }

  get(jobId: string): RunJobSnapshot<Result> | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;

    const { controller: _controller, ...snapshot } = job;
    return { ...snapshot };
  }

  get retainedJobCount(): number {
    return this.jobs.size;
  }

  /** Release a terminal job after its consumer has read the final snapshot/result. */
  release(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || !isTerminal(job.status)) return false;
    return this.jobs.delete(jobId);
  }

  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || isTerminal(job.status)) return false;

    job.status = 'cancelling';
    job.controller.abort(new DOMException('Run cancelled', 'AbortError'));
    return true;
  }

  private async execute(
    job: InternalJob<Result>,
    executor: RunExecutor<Result>,
    options: RunOptions<Result>
  ): Promise<Result> {
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
        if (options.cancellationResult) {
          const cancellationResult = options.cancellationResult(result);
          job.result = cancellationResult;
          markCancelled(job);
          throw new RunCancelledWithResultError(cancellationResult);
        }
        markCancelled(job);
        throw abortReason(job.controller.signal);
      }

      job.status = options.classifyResult?.(result) ?? 'passed';
      job.progress = 1;
      job.result = result;
      job.finishedAt = Date.now();
      return result;
    } catch (error) {
      if (isRunCancelledWithResult<Result>(error)) throw error;
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
