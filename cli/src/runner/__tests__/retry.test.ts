import { describe, it, expect } from 'vitest';
import { withRetry, parseRetryOn } from '../retry';
import type { ExecuteOutcome } from '../executors/types';

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

describe('parseRetryOn', () => {
  it('parses a mix of keywords and numeric codes', () => {
    expect(parseRetryOn('network,5xx,418')).toEqual(['network', '5xx', 418]);
  });

  it('rejects unknown tokens', () => {
    expect(() => parseRetryOn('not-a-thing')).toThrow();
  });
});
