import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Collection, Environment, HttpRequest, Response } from '@/types';
import type {
  CollectionRunResult,
  RequestCompleteInfo,
  RunProgress,
} from '../../lib/collectionRunner';

const mocks = vi.hoisted(() => ({
  addConsoleEntry: vi.fn(),
  addRun: vi.fn(),
  runCollection: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('../../lib/collectionRunner', () => ({
  runCollection: mocks.runCollection,
}));
vi.mock('@/store/useCollectionRunStore', () => ({
  useCollectionRunStore: { getState: () => ({ addRun: mocks.addRun }) },
}));
vi.mock('@/store/useConsoleStore', () => ({
  useConsoleStore: { getState: () => ({ addEntry: mocks.addConsoleEntry }) },
}));
vi.mock('@/store/useEnvironmentStore', () => ({
  useEnvironmentStore: { getState: () => ({ environments: [] }) },
}));
vi.mock('@/store/useGlobalsStore', () => ({
  useGlobalsStore: { getState: () => ({ vars: {} }) },
}));
vi.mock('sonner', () => ({
  toast: { error: mocks.toastError },
}));

import { buildBaseVars, type StartRunArgs, useCollectionRun } from '../useCollectionRun';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const collection: Collection = { id: 'collection', name: 'Collection', items: [] };

function startArgs(): StartRunArgs {
  return {
    collection,
    scopeName: collection.name,
    runnables: [],
    environmentId: 'none',
    iterations: 1,
    dataRows: [],
    delayMs: 0,
    stopOnFailure: false,
    retention: 'metadata',
  };
}

function runResult(outcome: CollectionRunResult['outcome']): CollectionRunResult {
  return {
    id: 'run',
    collectionId: collection.id,
    collectionName: collection.name,
    scopeName: collection.name,
    startedAt: 1,
    durationMs: 2,
    iterations: 1,
    dataRows: 0,
    outcome,
    requests: [],
    summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
  };
}

function progress(done: boolean): RunProgress {
  return { completed: 0, total: 0, results: [], done };
}

function requestCompleteInfo(): RequestCompleteInfo {
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
  const response: Response = {
    id: 'response',
    requestId: request.id,
    status: 200,
    statusText: 'OK',
    headers: {},
    body: '',
    size: 0,
    time: 1,
    timestamp: 1,
  };
  return {
    result: {
      itemId: request.id,
      itemName: request.name,
      protocol: request.type,
      iteration: 0,
      status: 'success',
      assertions: [],
    },
    request,
    response,
    runId: 'run',
    scopeName: collection.name,
  };
}

beforeEach(() => {
  mocks.addConsoleEntry.mockReset();
  mocks.addRun.mockReset();
  mocks.runCollection.mockReset();
  mocks.toastError.mockReset();
});

describe('buildBaseVars', () => {
  it('layers globals, enabled environment values, then collection values', () => {
    const environment: Environment = {
      id: 'env',
      name: 'Environment',
      variables: [
        { id: 'e1', key: 'shared', value: 'environment', enabled: true },
        { id: 'e2', key: 'environmentOnly', value: 'yes', enabled: true },
        { id: 'e3', key: 'disabled', value: 'hidden', enabled: false },
      ],
    };
    const collection: Collection = {
      id: 'collection',
      name: 'Collection',
      items: [],
      variables: [
        { id: 'c1', key: 'shared', value: 'collection', enabled: true },
        { id: 'c2', key: 'collectionOnly', value: 'yes', enabled: true },
      ],
    };

    expect(buildBaseVars({ shared: 'global', globalOnly: 'yes' }, environment, collection)).toEqual(
      {
        shared: 'collection',
        globalOnly: 'yes',
        environmentOnly: 'yes',
        collectionOnly: 'yes',
      }
    );
  });

  it('layers a selected sub-environment over its base before collection values', () => {
    const base: Environment = {
      id: 'base',
      name: 'Base',
      variables: [{ id: 'base-v', key: 'host', value: 'base', enabled: true }],
    };
    const sub: Environment = {
      id: 'sub',
      name: 'Production',
      parentId: 'base',
      variables: [{ id: 'sub-v', key: 'host', value: 'sub', enabled: true }],
    };
    expect(
      buildBaseVars({ host: 'global' }, [base, sub], { id: 'c', name: 'C', items: [] })
    ).toEqual({
      host: 'sub',
    });
  });
});

describe('useCollectionRun lifecycle', () => {
  it('aborts an active run on unmount and rejects all late successful publications', async () => {
    const pending = deferred<CollectionRunResult>();
    let signal: AbortSignal | undefined;
    let onProgress: ((value: RunProgress) => void) | undefined;
    let onRequestComplete: ((value: RequestCompleteInfo) => void) | undefined;
    mocks.runCollection.mockImplementation(
      (
        _options: unknown,
        progressCallback: (value: RunProgress) => void,
        runSignal: AbortSignal,
        completeCallback: (value: RequestCompleteInfo) => void
      ) => {
        signal = runSignal;
        onProgress = progressCallback;
        onRequestComplete = completeCallback;
        return pending.promise;
      }
    );
    const { result, unmount } = renderHook(() => useCollectionRun());

    act(() => result.current.start(startArgs()));
    expect(signal?.aborted).toBe(false);

    unmount();
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      onProgress?.(progress(true));
      onRequestComplete?.(requestCompleteInfo());
      pending.resolve(runResult('aborted'));
      await pending.promise;
      await Promise.resolve();
    });

    expect(mocks.addConsoleEntry).not.toHaveBeenCalled();
    expect(mocks.addRun).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('does not surface a late runner rejection after unmount', async () => {
    const pending = deferred<CollectionRunResult>();
    mocks.runCollection.mockReturnValue(pending.promise);
    const { result, unmount } = renderHook(() => useCollectionRun());

    act(() => result.current.start(startArgs()));
    unmount();
    await act(async () => {
      pending.reject(new Error('too late'));
      await pending.promise.catch(() => undefined);
      await Promise.resolve();
    });

    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('keeps explicit stop results and completion state', async () => {
    const pending = deferred<CollectionRunResult>();
    let signal: AbortSignal | undefined;
    let onProgress: ((value: RunProgress) => void) | undefined;
    mocks.runCollection.mockImplementation(
      (
        _options: unknown,
        progressCallback: (value: RunProgress) => void,
        runSignal: AbortSignal
      ) => {
        signal = runSignal;
        onProgress = progressCallback;
        return pending.promise;
      }
    );
    const { result } = renderHook(() => useCollectionRun());

    act(() => {
      result.current.start(startArgs());
      result.current.stop();
    });
    expect(signal?.aborted).toBe(true);

    const aborted = runResult('aborted');
    await act(async () => {
      onProgress?.(progress(true));
      pending.resolve(aborted);
      await pending.promise;
    });

    expect(result.current.running).toBe(false);
    expect(result.current.progress).toEqual(progress(true));
    expect(mocks.addRun).toHaveBeenCalledWith(aborted);
  });

  it('stores a naturally completed run', async () => {
    const pending = deferred<CollectionRunResult>();
    mocks.runCollection.mockReturnValue(pending.promise);
    const { result } = renderHook(() => useCollectionRun());
    const completed = runResult('completed');

    act(() => result.current.start(startArgs()));
    await act(async () => {
      pending.resolve(completed);
      await pending.promise;
    });

    expect(result.current.running).toBe(false);
    expect(mocks.addRun).toHaveBeenCalledWith(completed);
  });
});
