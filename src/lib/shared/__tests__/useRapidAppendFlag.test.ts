import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRapidAppendFlag } from '../useRapidAppendFlag';

describe('useRapidAppendFlag', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('flags appends faster than the threshold and clears for slow ones', () => {
    let t = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => t);

    const { result, rerender } = renderHook(({ n }) => useRapidAppendFlag(n), {
      initialProps: { n: 0 },
    });
    expect(result.current).toBe(false);

    t = 1000;
    rerender({ n: 1 }); // 1000ms gap → slow
    expect(result.current).toBe(false);

    t = 1050;
    rerender({ n: 2 }); // 50ms gap → rapid
    expect(result.current).toBe(true);

    t = 1100;
    rerender({ n: 3 }); // still bursting
    expect(result.current).toBe(true);

    t = 2000;
    rerender({ n: 4 }); // 900ms gap → slow again
    expect(result.current).toBe(false);
  });

  it('never flags the first append as rapid, even right after page load', () => {
    let t = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => t);

    const { result, rerender } = renderHook(({ n }) => useRapidAppendFlag(n), {
      initialProps: { n: 0 },
    });

    t = 50; // within thresholdMs of navigation start
    rerender({ n: 1 });
    expect(result.current).toBe(false);
  });

  it('never flags removals (clear/filter) as rapid', () => {
    let t = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => t);

    const { result, rerender } = renderHook(({ n }) => useRapidAppendFlag(n), {
      initialProps: { n: 5 },
    });

    t = 10;
    rerender({ n: 0 }); // fast, but a removal
    expect(result.current).toBe(false);
  });
});
