import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useResettableTimeout } from '../useResettableTimeout';

describe('useResettableTimeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('replaces a pending timeout when rescheduled', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result } = renderHook(() => useResettableTimeout());
    act(() => {
      result.current(first, 1000);
      result.current(second, 1000);
    });
    act(() => vi.advanceTimersByTime(1000));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('cancels the pending timeout when a reset trigger changes or on unmount', () => {
    const fn = vi.fn();
    const { result, rerender, unmount } = renderHook(({ open }) => useResettableTimeout([open]), {
      initialProps: { open: true },
    });
    act(() => result.current(fn, 1000));
    rerender({ open: false });
    act(() => vi.advanceTimersByTime(1000));
    expect(fn).not.toHaveBeenCalled();

    act(() => result.current(fn, 1000));
    unmount();
    act(() => vi.advanceTimersByTime(1000));
    expect(fn).not.toHaveBeenCalled();
  });
});
