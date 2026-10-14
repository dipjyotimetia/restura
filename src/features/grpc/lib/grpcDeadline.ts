import type { GrpcRequest } from '@/types';

/** Default per-call deadline when a request doesn't set one. */
export const DEFAULT_GRPC_DEADLINE_MS = 30_000;

/** `timeout` value meaning "no deadline" — honoured for streaming methods only. */
export const NO_GRPC_DEADLINE = 0;

/** True when the request opted out of a deadline (streaming methods only). */
export function hasNoDeadline(request: Pick<GrpcRequest, 'methodType' | 'timeout'>): boolean {
  return request.methodType !== 'unary' && request.timeout === NO_GRPC_DEADLINE;
}

/**
 * The deadline (ms) to run a request with. Returns {@link NO_GRPC_DEADLINE} (0)
 * for a streaming request that opted out — watch/subscribe streams may run for
 * hours (gRPC deadlines are optional). Unary calls always get a deadline: a
 * missing or non-positive `timeout` falls back to the 30s default.
 */
export function grpcDeadlineMs(request: Pick<GrpcRequest, 'methodType' | 'timeout'>): number {
  if (hasNoDeadline(request)) return NO_GRPC_DEADLINE;
  return request.timeout && request.timeout > 0 ? request.timeout : DEFAULT_GRPC_DEADLINE_MS;
}
