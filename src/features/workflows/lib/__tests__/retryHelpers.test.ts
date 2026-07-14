import { describe, expect, it, vi } from 'vitest';
import { executeWithRetry } from '../retryHelpers';

describe('executeWithRetry', () => {
  it('returns on first success without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await executeWithRetry(fn, {
      policy: { maxAttempts: 3, delayMs: 1 },
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure up to maxAttempts', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('a'))
      .mockRejectedValueOnce(new Error('b'))
      .mockResolvedValue('done');
    const onRetry = vi.fn();
    const result = await executeWithRetry(fn, {
      policy: { maxAttempts: 3, delayMs: 1 },
      onRetry,
    });
    expect(result).toBe('done');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('throws the last error after exhausting attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('last'));
    await expect(executeWithRetry(fn, { policy: { maxAttempts: 2, delayMs: 1 } })).rejects.toThrow(
      'last'
    );
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('applies backoff multiplier across attempts', async () => {
    const delays: number[] = [];
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('1'))
      .mockRejectedValueOnce(new Error('2'))
      .mockResolvedValue('ok');
    await executeWithRetry(fn, {
      policy: { maxAttempts: 3, delayMs: 10, backoffMultiplier: 2 },
      onRetry: (_attempt, delay) => delays.push(delay),
    });
    expect(delays).toEqual([10, 20]);
  });

  it('aborts immediately on pre-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn().mockResolvedValue('never');
    await expect(
      executeWithRetry(fn, {
        policy: { maxAttempts: 3, delayMs: 1 },
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('aborts during inter-attempt sleep', async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockRejectedValue(new Error('fail'));
    const promise = executeWithRetry(fn, {
      policy: { maxAttempts: 3, delayMs: 1000 },
      signal: controller.signal,
    });
    // Wait until the first failure scheduled the sleep, then abort.
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry after an AbortError', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));
    await expect(
      executeWithRetry(fn, { policy: { maxAttempts: 3, delayMs: 1 } })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
