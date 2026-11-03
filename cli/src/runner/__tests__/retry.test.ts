import { GrpcStatusCode, GrpcStatusCodeName } from '@shared/protocol/grpc-status';
import { describe, expect, it } from 'vitest';
import type { ExecuteOutcome } from '../executors/types';
import {
  MAX_RETRY_AFTER_MS,
  parseRetryOn,
  type RetryOptions,
  retryDelayMs,
  withRetry,
} from '../retry';

function outcome(status: number, errorMessage?: string, passed = false): ExecuteOutcome {
  return {
    status,
    passed,
    durationMs: 5,
    bodyBytes: 0,
    ...(errorMessage ? { errorMessage } : {}),
  };
}

describe('withRetry', () => {
  it('does not retry when retries=0', async () => {
    let calls = 0;
    const result = await withRetry(
      () => {
        calls++;
        return Promise.resolve(outcome(500));
      },
      { retries: 0, retryOn: ['5xx'], baseDelayMs: 1 }
    );
    expect(calls).toBe(1);
    expect(result.status).toBe(500);
  });

  it('retries on 5xx up to N additional attempts then returns last', async () => {
    let calls = 0;
    const result = await withRetry(
      () => {
        calls++;
        return Promise.resolve(outcome(503));
      },
      { retries: 2, retryOn: ['5xx'], baseDelayMs: 1 }
    );
    expect(calls).toBe(3);
    expect(result.status).toBe(503);
  });

  it('stops retrying once an outcome no longer matches the rules', async () => {
    let calls = 0;
    const result = await withRetry(
      () => {
        calls++;
        if (calls === 1) return Promise.resolve(outcome(503));
        return Promise.resolve(outcome(200, undefined, true));
      },
      { retries: 5, retryOn: ['5xx'], baseDelayMs: 1 }
    );
    expect(calls).toBe(2);
    expect(result.status).toBe(200);
  });

  it('treats status 0 + errorMessage as a network failure', async () => {
    let calls = 0;
    const result = await withRetry(
      () => {
        calls++;
        return Promise.resolve(outcome(0, 'ECONNREFUSED'));
      },
      { retries: 2, retryOn: ['network'], baseDelayMs: 1 }
    );
    expect(calls).toBe(3);
    expect(result.errorMessage).toBe('ECONNREFUSED');
  });

  it('accumulates durations across attempts', async () => {
    const result = await withRetry(() => Promise.resolve(outcome(500)), {
      retries: 2,
      retryOn: ['5xx'],
      baseDelayMs: 1,
    });
    expect(result.durationMs).toBe(15); // 3 * 5
  });
});

describe('retry semantics', () => {
  async function attempts(
    o: ExecuteOutcome,
    retryOn: RetryOptions['retryOn'] = ['network', '5xx']
  ): Promise<number> {
    let calls = 0;
    await withRetry(
      () => {
        calls++;
        return Promise.resolve(o);
      },
      { retries: 2, retryOn, baseDelayMs: 1 }
    );
    return calls;
  }

  it.each([
    ['an SSE 404', outcome(404, 'SSE upstream returned 404')],
    ['an SSRF/validation refusal with an HTTP status', outcome(403, 'Blocked private address')],
    [
      'a gRPC application error',
      { ...outcome(0, 'gRPC NOT_FOUND'), grpcStatus: { code: 5, message: 'x' } },
    ],
  ])('network does not retry %s', async (_label, o) => {
    expect(await attempts(o, ['network'])).toBe(1);
  });

  it('never retries a pre-I/O refusal, whatever the rules', async () => {
    const refused: ExecuteOutcome = { ...outcome(0, 'NTLM is desktop-only'), refused: true };
    expect(await attempts(refused, ['network', '5xx', '4xx', 0])).toBe(1);
  });

  it('honours Retry-After (seconds or HTTP-date, capped) on 429 and 503', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const withHeader = (status: number, value: string): ExecuteOutcome => ({
      ...outcome(status),
      responseHeaders: { 'retry-after': value },
    });
    expect(retryDelayMs(withHeader(429, '2'), 0, 250, now)).toBe(2000);
    expect(retryDelayMs(withHeader(503, 'Thu, 01 Jan 2026 00:00:03 GMT'), 0, 250, now)).toBe(3000);
    expect(retryDelayMs(withHeader(503, '99999'), 0, 250, now)).toBe(MAX_RETRY_AFTER_MS);
    // A past date retries now; garbage, or a status that does not carry it: backoff.
    expect(retryDelayMs(withHeader(429, 'Wed, 31 Dec 2025 00:00:00 GMT'), 1, 250, now)).toBe(0);
    expect(retryDelayMs(withHeader(429, 'soon'), 1, 250, now)).toBe(500);
    expect(retryDelayMs(withHeader(500, '5'), 2, 250, now)).toBe(1000);
  });
});

describe('gRPC retry semantics', () => {
  const grpc = (code: GrpcStatusCode): ExecuteOutcome => ({
    // The executor maps gRPC failures to an HTTP-ish status (here 500).
    ...outcome(500, `gRPC ${GrpcStatusCodeName[code]}`),
    grpcStatus: { code, message: GrpcStatusCodeName[code] ?? '' },
  });
  async function attempts(o: ExecuteOutcome): Promise<number> {
    let calls = 0;
    await withRetry(
      () => {
        calls++;
        return Promise.resolve(o);
      },
      { retries: 2, retryOn: ['network', '5xx'], baseDelayMs: 1 }
    );
    return calls;
  }

  it.each([
    GrpcStatusCode.INVALID_ARGUMENT,
    GrpcStatusCode.NOT_FOUND,
    GrpcStatusCode.PERMISSION_DENIED,
    GrpcStatusCode.INTERNAL,
    GrpcStatusCode.UNIMPLEMENTED,
  ])('5xx makes exactly one attempt for gRPC application error %i', async (code) => {
    expect(await attempts(grpc(code))).toBe(1);
  });

  it.each([
    GrpcStatusCode.UNAVAILABLE,
    GrpcStatusCode.DEADLINE_EXCEEDED,
    GrpcStatusCode.RESOURCE_EXHAUSTED,
  ])('5xx retries transient gRPC status %i', async (code) => {
    expect(await attempts(grpc(code))).toBe(3);
  });

  it('a transient gRPC status the executor reports with status 0 is retried under 5xx too', async () => {
    expect(await attempts({ ...grpc(GrpcStatusCode.UNAVAILABLE), status: 0 })).toBe(3);
    expect(await attempts({ ...grpc(GrpcStatusCode.NOT_FOUND), status: 0 })).toBe(1);
  });

  it('a transient gRPC status is not retried when 5xx is not a trigger', async () => {
    let calls = 0;
    await withRetry(
      () => {
        calls++;
        return Promise.resolve(grpc(GrpcStatusCode.UNAVAILABLE));
      },
      { retries: 2, retryOn: ['network'], baseDelayMs: 1 }
    );
    expect(calls).toBe(1);
  });
});

describe('parseRetryOn', () => {
  it('parses a mix of keywords and numeric codes', () => {
    expect(parseRetryOn('network,5xx,418')).toEqual(['network', '5xx', 418]);
  });

  it('rejects unknown tokens', () => {
    expect(() => parseRetryOn('not-a-thing')).toThrow();
  });
});
