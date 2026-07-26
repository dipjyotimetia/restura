import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ReleaseNote,
  ReleaseNotesChannel,
  ReleaseNotesPage,
} from '@/lib/shared/release-notes';
import { clearReleaseNotesCache, fetchReleaseNotesPage } from '@/lib/shared/release-notes';
import { useReleaseNotes } from '../useReleaseNotes';

vi.mock('@/lib/shared/release-notes', () => ({
  clearReleaseNotesCache: vi.fn(),
  fetchReleaseNotesPage: vi.fn(),
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function release(id: number, tag: string, isPrerelease = false): ReleaseNote {
  return {
    id,
    tag,
    name: tag,
    body: `${tag} changes`,
    url: `https://github.com/dipjyotimetia/restura/releases/tag/${tag}`,
    publishedAt: '2026-07-25T00:00:00Z',
    isPrerelease,
  };
}

function page(releases: ReleaseNote[], nextPage: number | null = null): ReleaseNotesPage {
  return { releases, nextPage };
}

const mockFetchReleaseNotesPage = vi.mocked(fetchReleaseNotesPage);
const mockClearReleaseNotesCache = vi.mocked(clearReleaseNotesCache);

describe('useReleaseNotes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ignores a previous channel response while the current channel is loading', async () => {
    const stable = deferred<ReleaseNotesPage>();
    const beta = deferred<ReleaseNotesPage>();
    mockFetchReleaseNotesPage.mockImplementation(({ channel }) =>
      channel === 'stable' ? stable.promise : beta.promise
    );

    const initialProps: { channel: ReleaseNotesChannel } = { channel: 'stable' };
    const { result, rerender } = renderHook(({ channel }) => useReleaseNotes(channel), {
      initialProps,
    });

    await waitFor(() =>
      expect(mockFetchReleaseNotesPage).toHaveBeenCalledWith({ channel: 'stable' })
    );
    rerender({ channel: 'beta' });
    await waitFor(() =>
      expect(mockFetchReleaseNotesPage).toHaveBeenCalledWith({ channel: 'beta' })
    );

    await act(async () => {
      stable.resolve(page([release(1, 'v1.0.0')]));
      await stable.promise;
    });

    expect(result.current.loading).toBe(true);
    expect(result.current.releases).toEqual([]);
    expect(result.current.selectedId).toBeNull();

    await act(async () => {
      beta.resolve(page([release(2, 'v1.1.0-beta.1', true)]));
      await beta.promise;
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.releases).toEqual([release(2, 'v1.1.0-beta.1', true)]);
    expect(result.current.selectedId).toBe(2);
  });

  it('ignores an earlier reload after a refresh starts', async () => {
    const initial = deferred<ReleaseNotesPage>();
    const refreshed = deferred<ReleaseNotesPage>();
    mockFetchReleaseNotesPage
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(refreshed.promise);

    const { result } = renderHook(() => useReleaseNotes('stable'));
    await waitFor(() => expect(mockFetchReleaseNotesPage).toHaveBeenCalledTimes(1));

    let refreshPromise!: Promise<void>;
    act(() => {
      refreshPromise = result.current.reload(true);
    });

    expect(mockClearReleaseNotesCache).toHaveBeenCalledTimes(1);

    await act(async () => {
      refreshed.resolve(page([release(2, 'v1.1.0')]));
      await refreshPromise;
    });

    await act(async () => {
      initial.resolve(page([release(1, 'v1.0.0')]));
      await initial.promise;
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.releases).toEqual([release(2, 'v1.1.0')]);
    expect(result.current.selectedId).toBe(2);
  });

  it('does not append an obsolete page after a full reload', async () => {
    const olderPage = deferred<ReleaseNotesPage>();
    const refreshed = deferred<ReleaseNotesPage>();
    mockFetchReleaseNotesPage
      .mockResolvedValueOnce(page([release(2, 'v1.1.0')], 2))
      .mockReturnValueOnce(olderPage.promise)
      .mockReturnValueOnce(refreshed.promise);

    const { result } = renderHook(() => useReleaseNotes('stable'));
    await waitFor(() => expect(result.current.nextPage).toBe(2));

    let loadMorePromise!: Promise<void>;
    act(() => {
      loadMorePromise = result.current.loadMore();
    });
    expect(result.current.loadingMore).toBe(true);

    let reloadPromise!: Promise<void>;
    act(() => {
      reloadPromise = result.current.reload(true);
    });

    expect(result.current.loading).toBe(true);
    expect(result.current.loadingMore).toBe(false);

    await act(async () => {
      refreshed.resolve(page([release(3, 'v1.2.0')], 3));
      await reloadPromise;
    });

    await act(async () => {
      olderPage.resolve(page([release(1, 'v1.0.0')], null));
      await loadMorePromise;
    });

    expect(result.current.releases).toEqual([release(3, 'v1.2.0')]);
    expect(result.current.selectedId).toBe(3);
    expect(result.current.nextPage).toBe(3);
    expect(result.current.loading).toBe(false);
    expect(result.current.loadingMore).toBe(false);
  });

  it('deduplicates repeated load-more calls for the same page', async () => {
    const olderPage = deferred<ReleaseNotesPage>();
    mockFetchReleaseNotesPage
      .mockResolvedValueOnce(page([release(2, 'v1.1.0')], 2))
      .mockReturnValue(olderPage.promise);

    const { result } = renderHook(() => useReleaseNotes('stable'));
    await waitFor(() => expect(result.current.nextPage).toBe(2));

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.loadMore();
      second = result.current.loadMore();
    });

    expect(mockFetchReleaseNotesPage).toHaveBeenCalledTimes(2);
    expect(mockFetchReleaseNotesPage).toHaveBeenLastCalledWith({
      channel: 'stable',
      page: 2,
    });

    await act(async () => {
      olderPage.resolve(page([release(1, 'v1.0.0')]));
      await Promise.all([first, second]);
    });

    expect(result.current.releases).toEqual([release(2, 'v1.1.0'), release(1, 'v1.0.0')]);
    expect(result.current.loadingMore).toBe(false);
  });

  it('surfaces initial-load failures and supports an empty page', async () => {
    mockFetchReleaseNotesPage.mockRejectedValueOnce(new Error('GitHub unavailable'));
    const { result } = renderHook(() => useReleaseNotes('stable'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('GitHub unavailable');
    expect(result.current.releases).toEqual([]);
    expect(result.current.selectedId).toBeNull();
    expect(result.current.nextPage).toBeNull();
  });

  it('uses the fallback message for non-Error pagination failures', async () => {
    mockFetchReleaseNotesPage
      .mockResolvedValueOnce(page([release(2, 'v1.1.0')], 2))
      .mockRejectedValueOnce('offline');
    const { result } = renderHook(() => useReleaseNotes('stable'));
    await waitFor(() => expect(result.current.nextPage).toBe(2));

    await act(async () => {
      await result.current.loadMore();
    });

    expect(result.current.error).toBe('Release notes are unavailable right now.');
    expect(result.current.loadingMore).toBe(false);
    expect(result.current.releases).toEqual([release(2, 'v1.1.0')]);
  });

  it('does nothing when there is no next page', async () => {
    mockFetchReleaseNotesPage.mockResolvedValueOnce(page([]));
    const { result } = renderHook(() => useReleaseNotes('stable'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.loadMore();
    });

    expect(mockFetchReleaseNotesPage).toHaveBeenCalledTimes(1);
    expect(result.current.loadingMore).toBe(false);
  });
});
