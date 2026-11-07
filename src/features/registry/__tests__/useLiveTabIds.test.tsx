import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { liveTabIds, useLiveTabIds } from '@/features/registry/liveConnections';
import { protocolRegistry } from '@/features/registry/registry';
import type { ProtocolModule } from '@/features/registry/types';

const live = new Set<string>();
let registered = false;

function registerFake() {
  if (registered) return;
  registered = true;
  protocolRegistry.register({
    id: 'fake-hook-protocol',
    connectionLifecycle: {
      connectionIdForTab: () => undefined,
      disconnect: () => undefined,
      removeConnectionForTab: () => undefined,
      isLive: (tabId: string) => live.has(tabId),
    },
  } as unknown as ProtocolModule);
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
}

describe('liveTabIds without lifecycles', () => {
  it('reports nothing live when no protocol exposes isLive', () => {
    // Runs first, before this file registers its fake protocol.
    if (protocolRegistry.list().some((m) => m.connectionLifecycle?.isLive)) return;
    expect(liveTabIds(['a', 'b'])).toEqual([]);
  });
});

describe('useLiveTabIds', () => {
  beforeEach(() => {
    registerFake();
    live.clear();
    setVisibility('visible');
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    setVisibility('visible');
  });

  it('re-renders when the polled live set changes', () => {
    const { result } = renderHook(() => useLiveTabIds(['t1', 't2'], 500));
    expect(result.current).toEqual([]);
    live.add('t2');
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toEqual(['t2']);
    // No change → no extra render needed; result stays stable.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toEqual(['t2']);
  });

  it('skips polling while the document is hidden', () => {
    const { result } = renderHook(() => useLiveTabIds(['t1']));
    setVisibility('hidden');
    live.add('t1');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toEqual([]);
    setVisibility('visible');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toEqual(['t1']);
  });

  it('stops polling on unmount', () => {
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const { unmount } = renderHook(() => useLiveTabIds(['t1']));
    unmount();
    expect(clear).toHaveBeenCalled();
  });
});
