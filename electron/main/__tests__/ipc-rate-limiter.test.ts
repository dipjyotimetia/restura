// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createKeyedRateLimiter, createRateLimiter } from '../ipc-rate-limiter';

describe('createKeyedRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-13T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keys quotas independently per webContents id', () => {
    const limiter = createKeyedRateLimiter(3, 1000);
    expect(limiter.check(1)).toBe(true);
    expect(limiter.check(1)).toBe(true);
    expect(limiter.check(1)).toBe(true);
    expect(limiter.check(1)).toBe(false);
    expect(limiter.check(2)).toBe(true); // different key → independent budget
  });

  it('expires entries after window passes', () => {
    const limiter = createKeyedRateLimiter(2, 1000);
    expect(limiter.check(1)).toBe(true);
    expect(limiter.check(1)).toBe(true);
    expect(limiter.check(1)).toBe(false);
    vi.advanceTimersByTime(1001);
    expect(limiter.check(1)).toBe(true);
  });

  it('cleans up dead webContents on dispose', () => {
    const limiter = createKeyedRateLimiter(1, 1000);
    limiter.check(99);
    limiter.dispose(99);
    expect(limiter.size()).toBe(0);
  });

  it('isolates dispose to a single key', () => {
    const limiter = createKeyedRateLimiter(2, 1000);
    limiter.check(1);
    limiter.check(2);
    limiter.dispose(1);
    expect(limiter.size()).toBe(1);
    // dispose of key 1 reset its budget — sanity check
    expect(limiter.check(1)).toBe(true);
    expect(limiter.check(2)).toBe(true);
    expect(limiter.check(2)).toBe(false);
  });

  it('allows burst after window for a specific key', () => {
    const limiter = createKeyedRateLimiter(2, 100);
    limiter.check(1);
    limiter.check(1);
    vi.advanceTimersByTime(200);
    expect(limiter.check(1)).toBe(true);
    expect(limiter.check(1)).toBe(true);
    expect(limiter.check(1)).toBe(false);
  });
});

describe('createRateLimiter (legacy shim)', () => {
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
});
