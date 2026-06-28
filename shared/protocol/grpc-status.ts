export enum GrpcStatusCode {
  OK = 0,
  CANCELLED = 1,
  UNKNOWN = 2,
  INVALID_ARGUMENT = 3,
  DEADLINE_EXCEEDED = 4,
  NOT_FOUND = 5,
  ALREADY_EXISTS = 6,
  PERMISSION_DENIED = 7,
  RESOURCE_EXHAUSTED = 8,
  FAILED_PRECONDITION = 9,
  ABORTED = 10,
  OUT_OF_RANGE = 11,
  UNIMPLEMENTED = 12,
  INTERNAL = 13,
  UNAVAILABLE = 14,
  DATA_LOSS = 15,
  UNAUTHENTICATED = 16,
}

/**
 * Canonical gRPC status code → HTTP status code mapping, matching grpc-gateway's
 * `HTTPStatusFromCode` (https://github.com/grpc-ecosystem/grpc-gateway). Used to
 * present gRPC results on the HTTP-centric surfaces of the UI (the Network console
 * status pills/classification, the response status badge) where a code needs an
 * HTTP-range equivalent. Unknown/out-of-range codes fall back to 500.
 */
const GRPC_TO_HTTP_STATUS: Record<GrpcStatusCode, number> = {
  [GrpcStatusCode.OK]: 200,
  [GrpcStatusCode.CANCELLED]: 499, // nginx "Client Closed Request"
  [GrpcStatusCode.UNKNOWN]: 500,
  [GrpcStatusCode.INVALID_ARGUMENT]: 400,
  [GrpcStatusCode.DEADLINE_EXCEEDED]: 504,
  [GrpcStatusCode.NOT_FOUND]: 404,
  [GrpcStatusCode.ALREADY_EXISTS]: 409,
  [GrpcStatusCode.PERMISSION_DENIED]: 403,
  [GrpcStatusCode.RESOURCE_EXHAUSTED]: 429,
  [GrpcStatusCode.FAILED_PRECONDITION]: 400,
  [GrpcStatusCode.ABORTED]: 409,
  [GrpcStatusCode.OUT_OF_RANGE]: 400,
  [GrpcStatusCode.UNIMPLEMENTED]: 501,
  [GrpcStatusCode.INTERNAL]: 500,
  [GrpcStatusCode.UNAVAILABLE]: 503,
  [GrpcStatusCode.DATA_LOSS]: 500,
  [GrpcStatusCode.UNAUTHENTICATED]: 401,
};

/** Map a gRPC status code onto its HTTP-status equivalent (grpc-gateway mapping). */
export function grpcStatusToHttpStatus(code: number): number {
  return GRPC_TO_HTTP_STATUS[code as GrpcStatusCode] ?? 500;
}

export const GrpcStatusCodeName: Record<GrpcStatusCode, string> = {
  [GrpcStatusCode.OK]: 'OK',
  [GrpcStatusCode.CANCELLED]: 'CANCELLED',
  [GrpcStatusCode.UNKNOWN]: 'UNKNOWN',
  [GrpcStatusCode.INVALID_ARGUMENT]: 'INVALID_ARGUMENT',
  [GrpcStatusCode.DEADLINE_EXCEEDED]: 'DEADLINE_EXCEEDED',
  [GrpcStatusCode.NOT_FOUND]: 'NOT_FOUND',
  [GrpcStatusCode.ALREADY_EXISTS]: 'ALREADY_EXISTS',
  [GrpcStatusCode.PERMISSION_DENIED]: 'PERMISSION_DENIED',
  [GrpcStatusCode.RESOURCE_EXHAUSTED]: 'RESOURCE_EXHAUSTED',
  [GrpcStatusCode.FAILED_PRECONDITION]: 'FAILED_PRECONDITION',
  [GrpcStatusCode.ABORTED]: 'ABORTED',
  [GrpcStatusCode.OUT_OF_RANGE]: 'OUT_OF_RANGE',
  [GrpcStatusCode.UNIMPLEMENTED]: 'UNIMPLEMENTED',
  [GrpcStatusCode.INTERNAL]: 'INTERNAL',
  [GrpcStatusCode.UNAVAILABLE]: 'UNAVAILABLE',
  [GrpcStatusCode.DATA_LOSS]: 'DATA_LOSS',
  [GrpcStatusCode.UNAUTHENTICATED]: 'UNAUTHENTICATED',
};
