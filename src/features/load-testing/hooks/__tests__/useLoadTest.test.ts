import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest } from '@/types';
import type { LoadProgress } from '../../lib/loadTestRunner';

const mocks = vi.hoisted(() => ({
  runLoadTest: vi.fn(),
}));

vi.mock('../../lib/loadTestRunner', () => ({
  runLoadTest: mocks.runLoadTest,
}));

import { useLoadTest } from '../useLoadTest';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const request: HttpRequest = {
  id: 'request',
  name: 'Request',
  type: 'http',
  method: 'GET',
  url: 'https://example.test',
  headers: [],
  params: [],
  body: { type: 'none' },
  auth: { type: 'none' },
};

function progress(done: boolean): LoadProgress {
  return {
    samples: [],
    completed: 0,
    total: 1,
    elapsedMs: 1,
    done,
  };
}

beforeEach(() => {
  mocks.runLoadTest.mockReset();
});

describe('useLoadTest lifecycle', () => {
  it('aborts an active load test on unmount', () => {
    const pending = deferred<LoadProgress>();
    let signal: AbortSignal | undefined;
    mocks.runLoadTest.mockImplementation(
      (
        _request: HttpRequest,
        _options: unknown,
        _onProgress: (value: LoadProgress) => void,
        runSignal: AbortSignal
      ) => {
        signal = runSignal;
        return pending.promise;
      }
    );
    const { result, unmount } = renderHook(() => useLoadTest());

    act(() => result.current.start(request, { iterations: 1, concurrency: 1 }));
    expect(signal?.aborted).toBe(false);

    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('keeps the final progress from an explicitly stopped run', async () => {
    const pending = deferred<LoadProgress>();
    let signal: AbortSignal | undefined;
    let onProgress: ((value: LoadProgress) => void) | undefined;
    mocks.runLoadTest.mockImplementation(
      (
        _request: HttpRequest,
        _options: unknown,
        progressCallback: (value: LoadProgress) => void,
        runSignal: AbortSignal
      ) => {
        signal = runSignal;
        onProgress = progressCallback;
        return pending.promise;
      }
    );
    const { result } = renderHook(() => useLoadTest());

    act(() => {
      result.current.start(request, { iterations: 1, concurrency: 1 });
      result.current.stop();
    });
    expect(signal?.aborted).toBe(true);

    const final = progress(true);
    await act(async () => {
      onProgress?.(final);
      pending.resolve(final);
      await pending.promise;
    });

    expect(result.current.running).toBe(false);
    expect(result.current.progress).toEqual(final);
  });

  it('keeps the final progress from a naturally completed run', async () => {
    const pending = deferred<LoadProgress>();
    let onProgress: ((value: LoadProgress) => void) | undefined;
    mocks.runLoadTest.mockImplementation(
      (
        _request: HttpRequest,
        _options: unknown,
        progressCallback: (value: LoadProgress) => void
      ) => {
        onProgress = progressCallback;
        return pending.promise;
      }
    );
    const { result } = renderHook(() => useLoadTest());
    const final = progress(true);

    act(() => result.current.start(request, { iterations: 1, concurrency: 1 }));
    await act(async () => {
      onProgress?.(final);
      pending.resolve(final);
      await pending.promise;
    });

    expect(result.current.running).toBe(false);
    expect(result.current.progress).toEqual(final);
  });

  it('ignores duplicate starts and progress from an unmounted run', async () => {
    const pending = deferred<LoadProgress>();
    let onProgress: ((value: LoadProgress) => void) | undefined;
    mocks.runLoadTest.mockImplementation(
      (
        _request: HttpRequest,
        _options: unknown,
        progressCallback: (value: LoadProgress) => void
      ) => {
        onProgress = progressCallback;
        return pending.promise;
      }
    );
    const { result, unmount } = renderHook(() => useLoadTest());

    act(() => {
      result.current.start(request, { iterations: 1, concurrency: 1 });
      result.current.start(request, { iterations: 1, concurrency: 1 });
    });
    expect(mocks.runLoadTest).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      onProgress?.(progress(true));
      pending.resolve(progress(true));
      await pending.promise;
    });
  });

  it('throttles non-final progress samples', () => {
    const pending = deferred<LoadProgress>();
    let onProgress: ((value: LoadProgress) => void) | undefined;
    mocks.runLoadTest.mockImplementation(
      (
        _request: HttpRequest,
        _options: unknown,
        progressCallback: (value: LoadProgress) => void
      ) => {
        onProgress = progressCallback;
        return pending.promise;
      }
    );
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValueOnce(101).mockReturnValueOnce(150);
    const { result } = renderHook(() => useLoadTest());

    act(() => {
      result.current.start(request, { iterations: 1, concurrency: 1 });
      onProgress?.(progress(false));
      onProgress?.({ ...progress(false), completed: 1 });
    });

    expect(result.current.progress?.completed).toBe(0);
    now.mockRestore();
  });
});
