export type RunKind = 'eval' | 'agent-suite';

export type RunStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'passed'
  | 'failed'
  | 'error'
  | 'cancelled';

export interface RunFailure {
  message: string;
  at: number;
}

export interface RunJobSnapshot<Result> {
  jobId: string;
  kind: RunKind;
  status: RunStatus;
  progress: number;
  startedAt: number;
  finishedAt?: number;
  result?: Result;
  failure?: RunFailure;
}

export interface RunExecutorContext {
  jobId: string;
  signal: AbortSignal;
  reportProgress(progress: number): void;
}
