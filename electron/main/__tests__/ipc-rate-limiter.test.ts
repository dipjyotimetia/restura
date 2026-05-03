// @vitest-environment node
import { vi } from 'vitest';
import { createRateLimiter } from '../ipc-rate-limiter';

describe('createRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows requests within limit', () => {
    const check = createRateLimiter(3, 1000);
    expect(check()).toBe(true);
    expect(check()).toBe(true);
    expect(check()).toBe(true);
  });

  it('blocks requests over limit', () => {
    const check = createRateLimiter(3, 1000);
    check();
    check();
    check();
    expect(check()).toBe(false);
  });

  it('resets after window expires', () => {
    const check = createRateLimiter(2, 100);
    check();
    check();
    expect(check()).toBe(false);
    vi.advanceTimersByTime(200);
    expect(check()).toBe(true);
  });

  it('allows burst after window', () => {
    const check = createRateLimiter(2, 100);
    check();
    check();
    vi.advanceTimersByTime(200);
    expect(check()).toBe(true);
    expect(check()).toBe(true);
    expect(check()).toBe(false);
  });
});
