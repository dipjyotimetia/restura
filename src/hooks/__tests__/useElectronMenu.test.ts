import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, () => void>(),
  getActiveTab: vi.fn(),
  getCollectionByItemId: vi.fn(),
  collections: [] as Array<{ id: string }>,
  toastInfo: vi.fn(),
}));

vi.mock('@/lib/shared/platform', () => ({
  onMenuEvent: (event: string, cb: () => void) => {
    mocks.listeners.set(event, cb);
    return () => mocks.listeners.delete(event);
  },
}));
vi.mock('@/store/useRequestStore', () => ({
  useRequestStore: { getState: () => ({ getActiveTab: mocks.getActiveTab }) },
}));
vi.mock('@/store/useCollectionStore', () => ({
  useCollectionStore: {
    getState: () => ({
      collections: mocks.collections,
      getCollectionByItemId: mocks.getCollectionByItemId,
    }),
  },
}));
vi.mock('sonner', () => ({ toast: { info: mocks.toastInfo } }));

import { useElectronMenuExport } from '../useElectronMenu';

describe('useElectronMenuExport', () => {
  beforeEach(() => {
    mocks.listeners.clear();
    mocks.getActiveTab.mockReset();
    mocks.getCollectionByItemId.mockReset();
    mocks.collections = [];
    mocks.toastInfo.mockReset();
  });

  it('subscribes only to menu:export (import / new-request are handled by the routes root)', () => {
    renderHook(() => useElectronMenuExport(vi.fn()));
    expect([...mocks.listeners.keys()]).toEqual(['menu:export']);
  });

  it('exports the collection that owns the active tab', () => {
    const onExport = vi.fn();
    mocks.collections = [{ id: 'c1' }, { id: 'c2' }];
    mocks.getActiveTab.mockReturnValue({ savedRequestId: 'r1' });
    mocks.getCollectionByItemId.mockImplementation((id: string) =>
      id === 'r1' ? { id: 'c2' } : undefined
    );
    renderHook(() => useElectronMenuExport(onExport));
    mocks.listeners.get('menu:export')?.();
    expect(onExport).toHaveBeenCalledWith('c2', 'postman-v3');
  });

  it('falls back to the only collection when no saved request is active', () => {
    const onExport = vi.fn();
    mocks.collections = [{ id: 'only' }];
    mocks.getActiveTab.mockReturnValue(null);
    renderHook(() => useElectronMenuExport(onExport));
    mocks.listeners.get('menu:export')?.();
    expect(onExport).toHaveBeenCalledWith('only', 'postman-v3');
  });

  it('tells the user how to pick a collection when the target is ambiguous', () => {
    const onExport = vi.fn();
    mocks.collections = [{ id: 'a' }, { id: 'b' }];
    mocks.getActiveTab.mockReturnValue({});
    renderHook(() => useElectronMenuExport(onExport));
    mocks.listeners.get('menu:export')?.();
    expect(onExport).not.toHaveBeenCalled();
    expect(mocks.toastInfo).toHaveBeenCalled();
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useElectronMenuExport(vi.fn()));
    unmount();
    expect(mocks.listeners.size).toBe(0);
  });
});
