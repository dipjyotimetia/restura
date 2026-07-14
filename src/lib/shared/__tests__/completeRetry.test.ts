import type { CompletionResult } from '@shared/protocol/ai/types';
import { describe, expect, it, vi } from 'vitest';
import { completeWithRetry } from '../completeRetry';

const ok = (text = 'ok'): CompletionResult => ({ ok: true, text, toolCalls: [] });
const fail = (code: 'provider' | 'network' | 'guard', message: string): CompletionResult => ({
  ok: false,
  text: '',
  toolCalls: [],
  error: { code, message },
});

// baseMs:0 keeps tests fast (no real backoff delay).
const NO_DELAY = { baseMs: 0 };

describe('completeWithRetry', () => {
  it('returns a successful result without retrying', async () => {
    const call = vi.fn(async () => ok());
    const r = await completeWithRetry(call, NO_DELAY);
    expect(r.ok).toBe(true);
    expect(call).toHaveBeenCalledOnce();
  });

  it('retries a transient ok:false result then succeeds', async () => {
    const call = vi
      .fn<() => Promise<CompletionResult>>()
      .mockResolvedValueOnce(fail('network', 'connection reset'))
      .mockResolvedValueOnce(ok('recovered'));
    const r = await completeWithRetry(call, NO_DELAY);
    expect(r).toMatchObject({ ok: true, text: 'recovered' });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('retries a 429/5xx provider error by message', async () => {
    const call = vi
      .fn<() => Promise<CompletionResult>>()
      .mockResolvedValueOnce(fail('provider', 'HTTP 503 overloaded'))
      .mockResolvedValueOnce(ok());
    await completeWithRetry(call, NO_DELAY);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a non-transient ok:false result', async () => {
    const call = vi.fn(async () => fail('guard', 'blocked by SSRF guard'));
    const r = await completeWithRetry(call, NO_DELAY);
    expect(r.ok).toBe(false);
    expect(call).toHaveBeenCalledOnce();
  });

  it('returns the last ok:false result once retries are exhausted', async () => {
    const call = vi.fn(async () => fail('network', 'timeout'));
    const r = await completeWithRetry(call, { retries: 2, baseMs: 0 });
    expect(r.ok).toBe(false);
    expect(call).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('retries a transient throw then succeeds', async () => {
    const call = vi
      .fn<() => Promise<CompletionResult>>()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(ok());
    await completeWithRetry(call, NO_DELAY);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('rethrows a non-transient throw immediately', async () => {
    const call = vi.fn(async () => {
      throw new Error('invalid model id');
    });
    await expect(completeWithRetry(call, NO_DELAY)).rejects.toThrow('invalid model id');
    expect(call).toHaveBeenCalledOnce();
  });

  it('does not start another retry after cancellation', async () => {
    const controller = new AbortController();
    const call = vi.fn(async () => {
      controller.abort(new DOMException('cancelled', 'AbortError'));
      return fail('network', 'timeout');
    });

    await expect(
      completeWithRetry(call, { retries: 2, baseMs: 0, signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(call).toHaveBeenCalledOnce();
  });
});
