import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useInspectorFetch } from '../useInspectorFetch';

type InspectorResult = { ok: true } | { ok: false; error: string };

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('useInspectorFetch', () => {
  it('surfaces a rejected initial load and clears busy state', async () => {
    const load = vi.fn<() => Promise<InspectorResult>>().mockRejectedValue(new Error('IPC failed'));

    const { result } = renderHook(() => useInspectorFetch('topic-a', load));

    await waitFor(() => {
      expect(result.current.error).toBe('IPC failed');
      expect(result.current.busy).toBe(false);
    });
  });

  it('surfaces a rejected manual refresh and clears busy state', async () => {
    const load = vi
      .fn<() => Promise<InspectorResult>>()
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('refresh failed'));
    const { result } = renderHook(() => useInspectorFetch('topic-a', load));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    await act(async () => {
      await expect(result.current.refresh()).resolves.toBeUndefined();
    });

    expect(result.current.error).toBe('refresh failed');
    expect(result.current.busy).toBe(false);
  });

  it('returns the resolved action result unchanged', async () => {
    const load = vi.fn<() => Promise<InspectorResult>>().mockResolvedValue({ ok: true });
    const actionResult = { ok: false as const, error: 'broker rejected the action' };
    const { result } = renderHook(() => useInspectorFetch('topic-a', load));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    let returned: InspectorResult | undefined;
    await act(async () => {
      returned = await result.current.run(async () => actionResult);
    });

    expect(returned).toBe(actionResult);
    expect(result.current.error).toBe(actionResult.error);
    expect(result.current.busy).toBe(false);
  });

  it('ignores an older refresh while a newer refresh is active', async () => {
    const older = deferred<InspectorResult>();
    const newer = deferred<InspectorResult>();
    const load = vi
      .fn<() => Promise<InspectorResult>>()
      .mockResolvedValueOnce({ ok: true })
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const { result } = renderHook(() => useInspectorFetch('topic-a', load));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    let olderRefresh!: Promise<void>;
    let newerRefresh!: Promise<void>;
    act(() => {
      olderRefresh = result.current.refresh();
      newerRefresh = result.current.refresh();
    });

    await act(async () => {
      older.resolve({ ok: false, error: 'stale failure' });
      await olderRefresh;
    });

    expect(result.current.busy).toBe(true);
    expect(result.current.error).toBeNull();

    await act(async () => {
      newer.resolve({ ok: false, error: 'latest failure' });
      await newerRefresh;
    });

    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBe('latest failure');
  });

  it('settles a rejected refresh without publishing after unmount', async () => {
    const late = deferred<InspectorResult>();
    const load = vi
      .fn<() => Promise<InspectorResult>>()
      .mockResolvedValueOnce({ ok: true })
      .mockReturnValueOnce(late.promise);
    const { result, unmount } = renderHook(() => useInspectorFetch('topic-a', load));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    let refresh!: Promise<void>;
    act(() => {
      refresh = result.current.refresh();
    });
    unmount();
    late.reject(new Error('too late'));

    await expect(refresh).resolves.toBeUndefined();
  });
});
