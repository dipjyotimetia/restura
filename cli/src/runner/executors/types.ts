import type { LoadedRequest } from '../collectionLoader';

/** Streaming event captured from SSE or WebSocket runs. */
export interface StreamEvent {
  /** SSE: event name; WS: 'message' / 'open' / 'close'. */
  event?: string;
  /** Raw payload as text. Binary WS frames are base64'd. */
  data: string;
  /** Unix ms. */
  timestamp: number;
}

/** gRPC status — surfaced separately from HTTP status because they're orthogonal. */
export interface GrpcStatusInfo {
  code: number;
  message: string;
}

export interface ExecuteOutcome {
  /** HTTP status code, or 0 for stream protocols / errors. */
  status: number;
  /** Whether the request itself succeeded at the transport layer. Script assertions can override this in the runner. */
  passed: boolean;
  durationMs: number;
  bodyBytes: number;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  errorMessage?: string;
  grpcStatus?: GrpcStatusInfo;
  streamEvents?: StreamEvent[];
}

export interface ExecuteOptions {
  vars: Record<string, string>;
  timeoutMs: number;
  allowLocalhost: boolean;
  /** SSE: max time to keep the stream open (ms). Default 5000. */
  sseDurationMs?: number;
  /** SSE: stop early after this many events. Default unbounded within duration. */
  sseMaxEvents?: number;
  /** WebSocket: max time to hold the socket open (ms). Default 5000. */
  wsDurationMs?: number;
  /** WebSocket: stop early after this many incoming messages. Default unbounded within duration. */
  wsMaxMessages?: number;
}

export type Executor = (req: LoadedRequest, opts: ExecuteOptions) => Promise<ExecuteOutcome>;
