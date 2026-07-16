import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMediaQuery } from '../useMediaQuery';

describe('useMediaQuery', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('updates only when the media-query match changes', () => {
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    const mediaQuery = {
      matches: false,
      media: '(max-width: 1279px)',
      addEventListener: (_: 'change', listener: (event: MediaQueryListEvent) => void) =>
        listeners.add(listener),
      removeEventListener: (_: 'change', listener: (event: MediaQueryListEvent) => void) =>
        listeners.delete(listener),
    };
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => mediaQuery)
    );

    const { result } = renderHook(() => useMediaQuery('(max-width: 1279px)'));
    expect(result.current).toBe(false);

    act(() => {
      mediaQuery.matches = true;
      for (const listener of listeners) listener({ matches: true } as MediaQueryListEvent);
    });
    expect(result.current).toBe(true);
  });
});
