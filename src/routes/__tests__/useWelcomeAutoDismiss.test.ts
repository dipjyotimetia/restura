import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useRequestStore } from '@/store/useRequestStore';
import { useWelcomeAutoDismiss } from '../useWelcomeAutoDismiss';

describe('useWelcomeAutoDismiss', () => {
  it('dismisses when a tab is opened from elsewhere (sidebar, palette, shortcut)', () => {
    const dismiss = vi.fn();
    renderHook(() => useWelcomeAutoDismiss(true, dismiss));
    act(() => {
      useRequestStore.getState().createNewRequest('http');
    });
    expect(dismiss).toHaveBeenCalled();
  });

  it('does nothing once the welcome screen is gone', () => {
    const dismiss = vi.fn();
    renderHook(() => useWelcomeAutoDismiss(false, dismiss));
    act(() => {
      useRequestStore.getState().createNewRequest('http');
    });
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('ignores edits that do not open, close or switch a tab', () => {
    const dismiss = vi.fn();
    act(() => {
      useRequestStore.getState().createNewRequest('http');
    });
    renderHook(() => useWelcomeAutoDismiss(true, dismiss));
    act(() => {
      useRequestStore.getState().updateRequest({ url: 'https://example.com' });
    });
    expect(dismiss).not.toHaveBeenCalled();
  });
});
