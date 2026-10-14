import { describe, expect, it } from 'vitest';
import { DEFAULT_GRPC_DEADLINE_MS, grpcDeadlineMs, hasNoDeadline } from '../grpcDeadline';

describe('grpcDeadlineMs', () => {
  it('defaults to 30s when no timeout is set', () => {
    expect(grpcDeadlineMs({ methodType: 'unary' })).toBe(DEFAULT_GRPC_DEADLINE_MS);
    expect(grpcDeadlineMs({ methodType: 'server-streaming' })).toBe(DEFAULT_GRPC_DEADLINE_MS);
  });

  it('keeps an explicit deadline', () => {
    expect(grpcDeadlineMs({ methodType: 'unary', timeout: 5000 })).toBe(5000);
    expect(grpcDeadlineMs({ methodType: 'bidirectional-streaming', timeout: 5000 })).toBe(5000);
  });

  it.each(['server-streaming', 'client-streaming', 'bidirectional-streaming'] as const)(
    'returns 0 (no deadline) for a %s request with timeout 0',
    (methodType) => {
      expect(hasNoDeadline({ methodType, timeout: 0 })).toBe(true);
      expect(grpcDeadlineMs({ methodType, timeout: 0 })).toBe(0);
    }
  );

  it('never runs a unary call without a deadline', () => {
    expect(hasNoDeadline({ methodType: 'unary', timeout: 0 })).toBe(false);
    expect(grpcDeadlineMs({ methodType: 'unary', timeout: 0 })).toBe(DEFAULT_GRPC_DEADLINE_MS);
  });
});
