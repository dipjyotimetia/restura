// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { bindLimiterToWebContents } from '../rate-limiter-cleanup';
import { fakeWebContents } from './helpers/electron-mock';
import type { KeyedRateLimiter } from '../ipc-rate-limiter';

function fakeLimiter(): KeyedRateLimiter {
  return { check: vi.fn(), dispose: vi.fn(), size: vi.fn() } as unknown as KeyedRateLimiter;
}

describe('bindLimiterToWebContents', () => {
  it('disposes every limiter bucket for the id when the renderer is destroyed', () => {
    const wc = fakeWebContents(42);
    const a = fakeLimiter();
    const b = fakeLimiter();

    bindLimiterToWebContents([a, b], wc as never);

    // Listener registered, but nothing disposed yet.
    expect(wc.once).toHaveBeenCalledWith('destroyed', expect.any(Function));
    expect(a.dispose).not.toHaveBeenCalled();

    // Fire the destroyed event.
    (wc.once.mock.calls[0]![1] as () => void)();
    expect(a.dispose).toHaveBeenCalledWith(42);
    expect(b.dispose).toHaveBeenCalledWith(42);
  });

  it('handles an empty limiter list without error', () => {
    const wc = fakeWebContents(1);
    bindLimiterToWebContents([], wc as never);
    expect(() => (wc.once.mock.calls[0]![1] as () => void)()).not.toThrow();
  });
});
