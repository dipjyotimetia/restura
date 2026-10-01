import { fireEvent, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSendShortcut } from './useSendShortcut';

describe('useSendShortcut', () => {
  it('runs the current action on Cmd/Ctrl+Enter only', () => {
    const { result } = renderHook(() => useSendShortcut());
    const action = vi.fn();
    result.current.current = action;

    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'Enter' });
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('does nothing without an action, or when another handler already claimed the key', () => {
    const { result } = renderHook(() => useSendShortcut());
    const unclaimed = new KeyboardEvent('keydown', {
      key: 'Enter',
      metaKey: true,
      cancelable: true,
    });
    window.dispatchEvent(unclaimed);
    expect(unclaimed.defaultPrevented).toBe(false);

    const action = vi.fn();
    result.current.current = action;
    const claimed = new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, cancelable: true });
    claimed.preventDefault();
    window.dispatchEvent(claimed);
    expect(action).not.toHaveBeenCalled();
  });

  it('stops listening on unmount', () => {
    const { result, unmount } = renderHook(() => useSendShortcut());
    const action = vi.fn();
    result.current.current = action;
    unmount();
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    expect(action).not.toHaveBeenCalled();
  });
});
