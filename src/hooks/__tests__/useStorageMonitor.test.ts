import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  stats: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock('@/lib/shared/dexie-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/shared/dexie-storage')>()),
  getDexieStorageStats: mocks.stats,
}));
vi.mock('sonner', () => ({ toast: { info: mocks.toastInfo } }));

import { useHistoryStore } from '@/store/useHistoryStore';
import { getStorageStatus, useStorageMonitor } from '../useStorageMonitor';

const MB = 1024 * 1024;
const originalStorage = Object.getOwnPropertyDescriptor(navigator, 'storage');

function setQuota(quota: number | undefined) {
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: { estimate: async () => ({ quota }) },
  });
}

/** Stats for a usage percentage of the (mocked) 100 MB default/quota. */
function usage(percent: number) {
  mocks.stats.mockResolvedValue({
    estimatedSize: (percent / 100) * 100 * MB,
    totalRecords: 7,
    tables: {},
    formattedSize: '',
  });
}

function seedHistory(count: number, favorites: string[] = []) {
  const history = Array.from({ length: count }, (_, i) => ({
    id: `h${i}`,
    timestamp: i,
    request: { id: `r${i}`, name: 'n', type: 'http', method: 'GET', url: 'u' },
  }));
  useHistoryStore.setState({ history: history as never, favorites });
}

beforeEach(() => {
  mocks.stats.mockReset();
  mocks.toastInfo.mockReset();
  setQuota(100 * MB);
  seedHistory(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalStorage) Object.defineProperty(navigator, 'storage', originalStorage);
  else Reflect.deleteProperty(navigator, 'storage');
});

describe('useStorageMonitor', () => {
  it('reports ok usage and formats bytes', async () => {
    usage(10);
    const { result } = renderHook(() => useStorageMonitor({ autoPrune: false }));
    await waitFor(() => expect(result.current.status.totalRecords).toBe(7));
    expect(result.current.status.level).toBe('ok');
    expect(result.current.status.message).toBeUndefined();
    expect(result.current.formattedUsed).toBe('10 MB');
    expect(result.current.formattedAvailable).toBe('100 MB');
    expect(result.current.formatBytes(0)).toBe('0 B');
    expect(result.current.formatBytes(1536)).toBe('1.5 KB');
  });

  it('flags a warning level', async () => {
    usage(75);
    const { result } = renderHook(() => useStorageMonitor({ autoPrune: false }));
    await waitFor(() => expect(result.current.status.level).toBe('warning'));
    expect(result.current.status.message).toMatch(/high \(75\.0%\)/);
  });

  it('flags a critical level, honouring custom thresholds', async () => {
    usage(50);
    const { result } = renderHook(() =>
      useStorageMonitor({ autoPrune: false, warningThreshold: 20, criticalThreshold: 40 })
    );
    await waitFor(() => expect(result.current.status.level).toBe('critical'));
    expect(result.current.status.message).toMatch(/almost full/);
  });

  it('uses the 100 MB default when the browser exposes no storage estimate', async () => {
    Reflect.deleteProperty(navigator, 'storage');
    usage(10);
    const { result } = renderHook(() => useStorageMonitor({ autoPrune: false }));
    await waitFor(() => expect(result.current.status.available).toBe(100 * MB));
  });

  it('uses the default when the estimate has no quota', async () => {
    setQuota(undefined);
    usage(10);
    const { result } = renderHook(() => useStorageMonitor({ autoPrune: false }));
    await waitFor(() => expect(result.current.status.available).toBe(100 * MB));
  });

  it('swallows a failing storage check', async () => {
    mocks.stats.mockRejectedValue(new Error('idb'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { result } = renderHook(() => useStorageMonitor({ autoPrune: false }));
    await waitFor(() => expect(err).toHaveBeenCalled());
    expect(result.current.status.level).toBe('ok');
    const manual = await act(() => result.current.checkStorage());
    expect(manual).toMatchObject({ used: 0, level: 'ok' });
  });

  describe('pruneOldHistory', () => {
    it('is a no-op when history is not larger than the request', () => {
      usage(1);
      seedHistory(3);
      const { result } = renderHook(() => useStorageMonitor({ autoPrune: false }));
      expect(result.current.pruneOldHistory(5)).toBe(0);
      expect(useHistoryStore.getState().history).toHaveLength(3);
    });

    it('removes the oldest non-favourite items first', () => {
      usage(1);
      seedHistory(6, ['h0']);
      const { result } = renderHook(() => useStorageMonitor({ autoPrune: false }));
      let removed = 0;
      act(() => {
        removed = result.current.pruneOldHistory(2);
      });
      expect(removed).toBe(2);
      const ids = useHistoryStore.getState().history.map((h) => h.id);
      expect(ids).toContain('h0');
      expect(ids).not.toContain('h1');
      expect(ids).not.toContain('h2');
    });
  });

  describe('auto prune', () => {
    it('prunes history and notifies when storage is critical', async () => {
      usage(95);
      seedHistory(30);
      renderHook(() => useStorageMonitor());
      await waitFor(() => expect(mocks.toastInfo).toHaveBeenCalled());
      expect(mocks.toastInfo.mock.calls[0]?.[0]).toMatch(/removed 10 oldest/);
      expect(useHistoryStore.getState().history.length).toBeLessThan(30);
    });

    it('stays quiet when nothing can be removed', async () => {
      usage(95);
      seedHistory(2);
      const { result } = renderHook(() => useStorageMonitor());
      await waitFor(() => expect(result.current.status.level).toBe('critical'));
      expect(mocks.toastInfo).not.toHaveBeenCalled();
    });

    it('does nothing below the critical threshold', async () => {
      usage(50);
      seedHistory(30);
      const { result } = renderHook(() => useStorageMonitor());
      await waitFor(() => expect(result.current.status.totalRecords).toBe(7));
      expect(mocks.toastInfo).not.toHaveBeenCalled();
      expect(useHistoryStore.getState().history).toHaveLength(30);
    });

    it('tolerates a missing storage estimate and quota while pruning', async () => {
      usage(1);
      Reflect.deleteProperty(navigator, 'storage');
      renderHook(() => useStorageMonitor());
      await waitFor(() => expect(mocks.stats).toHaveBeenCalledTimes(2));
      setQuota(undefined);
      renderHook(() => useStorageMonitor());
      await waitFor(() => expect(mocks.stats.mock.calls.length).toBeGreaterThanOrEqual(4));
    });
  });

  it('polls on the interval and stops on unmount', async () => {
    vi.useFakeTimers();
    usage(10);
    const { unmount } = renderHook(() =>
      useStorageMonitor({ autoPrune: false, pollInterval: 1000 })
    );
    await vi.advanceTimersByTimeAsync(0);
    const initial = mocks.stats.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.stats.mock.calls.length).toBe(initial + 2);
    unmount();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.stats.mock.calls.length).toBe(initial + 2);
  });
});

describe('getStorageStatus', () => {
  it.each([
    [10, 'ok'],
    [80, 'warning'],
    [95, 'critical'],
  ])('classifies %i%% usage as %s', async (pct, level) => {
    usage(pct);
    const out = await getStorageStatus();
    expect(out.level).toBe(level);
    expect(out.totalRecords).toBe(7);
    expect(out.available).toBe(100 * MB);
    if (level === 'ok') expect(out.message).toBeUndefined();
    else expect(out.message).toBeDefined();
  });

  it('uses the default capacity without a storage estimate or quota', async () => {
    usage(10);
    Reflect.deleteProperty(navigator, 'storage');
    expect((await getStorageStatus()).available).toBe(100 * MB);
    setQuota(undefined);
    expect((await getStorageStatus()).available).toBe(100 * MB);
  });

  it('returns an empty ok status when stats fail', async () => {
    mocks.stats.mockRejectedValue(new Error('x'));
    expect(await getStorageStatus()).toEqual({
      used: 0,
      available: 0,
      percentage: 0,
      totalRecords: 0,
      level: 'ok',
    });
  });
});
