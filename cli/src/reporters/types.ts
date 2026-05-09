import type { LoadedRequest } from '../runner/collectionLoader.js';

export interface RunMeta {
  collectionName: string;
  collectionDir: string;
  startedAt: number;
}

export interface RequestRunResult {
  request: LoadedRequest;
  status: number;
  passed: boolean;
  durationMs: number;
  bodyBytes: number;
  errorMessage?: string;
  responseHeaders?: Record<string, string>;
}

export interface RunResult {
  meta: RunMeta;
  durationMs: number;
  requests: RequestRunResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    errored: number;
  };
}

export interface Reporter {
  onStart?(meta: RunMeta): void | Promise<void>;
  onRequestStart?(request: LoadedRequest): void | Promise<void>;
  onRequestComplete?(result: RequestRunResult): void | Promise<void>;
  onEnd(result: RunResult): void | Promise<void>;
}
