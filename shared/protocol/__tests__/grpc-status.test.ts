import { describe, expect, it } from 'vitest';
import { GrpcStatusCode, grpcStatusFromHttpStatus, grpcStatusToHttpStatus } from '../grpc-status';

describe('grpcStatusToHttpStatus', () => {
  // Canonical grpc-gateway HTTPStatusFromCode mapping.
  it.each([
    [GrpcStatusCode.OK, 200],
    [GrpcStatusCode.CANCELLED, 499],
    [GrpcStatusCode.UNKNOWN, 500],
    [GrpcStatusCode.INVALID_ARGUMENT, 400],
    [GrpcStatusCode.DEADLINE_EXCEEDED, 504],
    [GrpcStatusCode.NOT_FOUND, 404],
    [GrpcStatusCode.ALREADY_EXISTS, 409],
    [GrpcStatusCode.PERMISSION_DENIED, 403],
    [GrpcStatusCode.RESOURCE_EXHAUSTED, 429],
    [GrpcStatusCode.FAILED_PRECONDITION, 400],
    [GrpcStatusCode.ABORTED, 409],
    [GrpcStatusCode.OUT_OF_RANGE, 400],
    [GrpcStatusCode.UNIMPLEMENTED, 501],
    [GrpcStatusCode.INTERNAL, 500],
    [GrpcStatusCode.UNAVAILABLE, 503],
    [GrpcStatusCode.DATA_LOSS, 500],
    [GrpcStatusCode.UNAUTHENTICATED, 401],
  ])('maps gRPC %i to HTTP %i', (code, http) => {
    expect(grpcStatusToHttpStatus(code)).toBe(http);
  });

  it('falls back to 500 for unknown/out-of-range codes', () => {
    expect(grpcStatusToHttpStatus(99)).toBe(500);
    expect(grpcStatusToHttpStatus(-1)).toBe(500);
  });
});

describe('grpcStatusFromHttpStatus (gRPC http-grpc-status-mapping)', () => {
  it.each([
    [400, GrpcStatusCode.INTERNAL],
    [401, GrpcStatusCode.UNAUTHENTICATED],
    [403, GrpcStatusCode.PERMISSION_DENIED],
    [404, GrpcStatusCode.UNIMPLEMENTED],
    [429, GrpcStatusCode.UNAVAILABLE],
    [502, GrpcStatusCode.UNAVAILABLE],
    [503, GrpcStatusCode.UNAVAILABLE],
    [504, GrpcStatusCode.UNAVAILABLE],
    [415, GrpcStatusCode.UNKNOWN],
    [500, GrpcStatusCode.UNKNOWN],
    [200, GrpcStatusCode.UNKNOWN],
  ])('maps HTTP %i to gRPC %i', (http, code) => {
    expect(grpcStatusFromHttpStatus(http)).toBe(code);
  });
});
