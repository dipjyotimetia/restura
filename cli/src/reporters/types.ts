import type { LoadedRequest } from '../runner/collectionLoader.js';

export interface RunMeta {
  collectionName: string;
  collectionDir: string;
  startedAt: number;
  /** 0-based iteration when `--data` is set; absent for single runs. */
  iteration?: number;
}

export interface AssertionResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface StreamEvent {
  event?: string;
  data: string;
  timestamp: number;
}

export interface GrpcStatusInfo {
  code: number;
  message: string;
}

export interface RequestRunResult {
  request: LoadedRequest;
  status: number;
  passed: boolean;
  durationMs: number;
  bodyBytes: number;
  errorMessage?: string;
  responseHeaders?: Record<string, string>;
  /** Populated by test script `pm.test(...)` calls when scripts run. */
  assertions?: AssertionResult[];
  /** SSE / WebSocket events captured during streaming protocol runs. */
  streamEvents?: StreamEvent[];
  /** gRPC status (code 0 = OK). Set only for gRPC requests. */
  grpcStatus?: GrpcStatusInfo;
  /** 0-based iteration when `--data` drove the run. */
  iteration?: number;
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
