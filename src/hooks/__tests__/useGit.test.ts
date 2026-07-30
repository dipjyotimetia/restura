import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getElectronAPI: vi.fn(),
  loadCollectionFromDirectory: vi.fn(),
  git: {
    init: vi.fn(),
    status: vi.fn(),
    log: vi.fn(),
    diff: vi.fn(),
    branchList: vi.fn(),
    add: vi.fn(),
    unstage: vi.fn(),
    discard: vi.fn(),
    commit: vi.fn(),
    createBranch: vi.fn(),
    checkoutBranch: vi.fn(),
    fetch: vi.fn(),
    pull: vi.fn(),
    push: vi.fn(),
    mergeState: vi.fn(),
    startMerge: vi.fn(),
    getMergeConflict: vi.fn(),
    resolveMergeConflict: vi.fn(),
    abortMerge: vi.fn(),
    completeMerge: vi.fn(),
  },
}));

vi.mock('@/lib/shared/platform', () => ({
  getElectronAPI: mocks.getElectronAPI,
}));

vi.mock('@/store/useFileCollectionStore', () => ({
  loadCollectionFromDirectory: mocks.loadCollectionFromDirectory,
}));

import { useGit } from '../useGit';

const DIRECTORY = '/collections/example';
const STATUS = {
  files: [{ path: 'request.yaml', staged: 'M', unstaged: ' ' }],
  branch: 'main',
  ahead: 1,
  behind: 0,
  clean: false,
};
const BRANCHES = [
  { name: 'main', isCurrent: true, isRemote: false },
  { name: 'origin/main', isCurrent: false, isRemote: true },
];
const COMMITS = [
  {
    sha: '1234567890abcdef',
    abbreviatedSha: '1234567',
    author: 'Restura',
    email: 'restura@example.com',
    timestamp: 1_700_000_000,
    subject: 'Add request',
  },
];

function useSuccessfulGitResults(): void {
  mocks.git.init.mockResolvedValue({ ok: true, initialized: true });
  mocks.git.status.mockResolvedValue({ ok: true, status: STATUS });
  mocks.git.log.mockResolvedValue({ ok: true, commits: COMMITS });
  mocks.git.diff.mockResolvedValue({ ok: true, diff: 'diff --git a/request.yaml b/request.yaml' });
  mocks.git.branchList.mockResolvedValue({ ok: true, branches: BRANCHES });
  mocks.git.add.mockResolvedValue({ ok: true, staged: true });
  mocks.git.unstage.mockResolvedValue({ ok: true, unstaged: true });
  mocks.git.discard.mockResolvedValue({ ok: true, discarded: true });
  mocks.git.commit.mockResolvedValue({
    ok: true,
    commit: { sha: 'abcdef1234567890', abbreviatedSha: 'abcdef1' },
  });
  mocks.git.createBranch.mockResolvedValue({ ok: true, branch: 'feature' });
  mocks.git.checkoutBranch.mockResolvedValue({ ok: true, branch: 'feature' });
  mocks.git.fetch.mockResolvedValue({ ok: true, remote: { remote: 'origin' } });
  mocks.git.pull.mockResolvedValue({ ok: true, result: { updated: true } });
  mocks.git.push.mockResolvedValue({
    ok: true,
    result: { remote: 'origin', branch: 'feature' },
  });
  mocks.git.mergeState.mockResolvedValue({
    ok: true,
    state: { phase: 'idle', branch: 'main', dirty: false },
  });
  mocks.git.startMerge.mockResolvedValue({
    ok: true,
    outcome: { kind: 'fast-forward', head: 'f'.repeat(40) },
  });
  mocks.git.getMergeConflict.mockResolvedValue({
    ok: true,
    conflict: {
      id: 'c'.repeat(64),
      path: 'request.yaml',
      relatedPaths: ['request.yaml'],
      status: 'both-modified',
      kind: 'text',
      strategy: 'text',
      base: { present: true, content: 'base' },
      local: { present: true, content: 'local' },
      incoming: { present: true, content: 'incoming' },
      proposedContent: 'local',
    },
  });
  mocks.git.resolveMergeConflict.mockResolvedValue({
    ok: true,
    state: {
      phase: 'ready-to-commit',
      branch: 'main',
      mergeHead: 'f'.repeat(40),
      suggestedMessage: 'Merge incoming',
    },
  });
  mocks.git.abortMerge.mockResolvedValue({ ok: true, result: { aborted: true } });
  mocks.git.completeMerge.mockResolvedValue({
    ok: true,
    commit: { sha: 'f'.repeat(40), abbreviatedSha: 'fffffff' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getElectronAPI.mockReturnValue({ git: mocks.git });
  mocks.loadCollectionFromDirectory.mockResolvedValue(undefined);
  useSuccessfulGitResults();
});

describe('useGit', () => {
  it('surfaces unavailable desktop Git and returns unavailable from every action', async () => {
    mocks.getElectronAPI.mockReturnValue(null);
    const { result } = renderHook(() => useGit(DIRECTORY));

    await waitFor(() => {
      expect(result.current.error).toBe('Git is only available in the desktop app');
    });

    await act(async () => {
      await expect(result.current.init()).resolves.toBe('Git unavailable');
      await expect(result.current.stage(['request.yaml'])).resolves.toBe('Git unavailable');
      await expect(result.current.unstage(['request.yaml'])).resolves.toBe('Git unavailable');
      await expect(result.current.discard(['request.yaml'])).resolves.toBe('Git unavailable');
      await expect(result.current.diff('request.yaml')).resolves.toBe('Git unavailable');
      await expect(result.current.commit('Update request')).resolves.toBe('Git unavailable');
      await expect(result.current.createBranch('feature')).resolves.toBe('Git unavailable');
      await expect(result.current.checkout('feature')).resolves.toBe('Git unavailable');
      await expect(result.current.fetch()).resolves.toBe('Git unavailable');
      await expect(result.current.pull()).resolves.toBe('Git unavailable');
      await expect(result.current.push()).resolves.toBe('Git unavailable');
    });

    expect(mocks.git.status).not.toHaveBeenCalled();
  });

  it('loads status, branches, and log from the desktop API', async () => {
    const { result } = renderHook(() => useGit(DIRECTORY));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.status).toEqual(STATUS);
    });

    expect(result.current.branches).toEqual(BRANCHES);
    expect(result.current.log).toEqual(COMMITS);
    expect(result.current.error).toBeNull();
    expect(result.current.notARepo).toBe(false);
    expect(result.current.mergeState).toEqual({ phase: 'idle', branch: 'main', dirty: false });
    expect(mocks.git.status).toHaveBeenCalledWith(DIRECTORY);
    expect(mocks.git.branchList).toHaveBeenCalledWith(DIRECTORY);
    expect(mocks.git.log).toHaveBeenCalledWith(DIRECTORY, 20);
    expect(mocks.git.mergeState).toHaveBeenCalledWith(DIRECTORY);
  });

  it('starts, inspects, resolves, aborts, and completes merges through the desktop API', async () => {
    const { result } = renderHook(() => useGit(DIRECTORY));
    await waitFor(() => expect(result.current.mergeState?.phase).toBe('idle'));
    mocks.loadCollectionFromDirectory.mockClear();

    await act(async () => {
      await expect(result.current.startMerge('origin/main', 'a'.repeat(40))).resolves.toBeNull();
    });
    expect(mocks.git.startMerge).toHaveBeenCalledWith(DIRECTORY, 'origin/main', 'a'.repeat(40));
    expect(mocks.loadCollectionFromDirectory).toHaveBeenCalledTimes(1);

    await act(async () => {
      await expect(result.current.getMergeConflict('c'.repeat(64))).resolves.toMatchObject({
        path: 'request.yaml',
        strategy: 'text',
      });
      await expect(
        result.current.resolveMergeConflict({
          conflictId: 'c'.repeat(64),
          kind: 'choice',
          choice: 'incoming',
        })
      ).resolves.toBeNull();
      await expect(result.current.abortMerge()).resolves.toBeNull();
      await expect(result.current.completeMerge('Merge incoming')).resolves.toBeNull();
    });

    expect(mocks.git.resolveMergeConflict).toHaveBeenCalledWith(DIRECTORY, {
      conflictId: 'c'.repeat(64),
      kind: 'choice',
      choice: 'incoming',
    });
    expect(mocks.git.abortMerge).toHaveBeenCalledWith(DIRECTORY);
    expect(mocks.git.completeMerge).toHaveBeenCalledWith(DIRECTORY, 'Merge incoming');
    expect(mocks.loadCollectionFromDirectory).toHaveBeenCalledTimes(4);
  });

  it('turns the stable not-a-repo result into initialization state', async () => {
    mocks.git.status.mockResolvedValue({
      ok: false,
      error: 'fatal: not a git repository',
      code: 'not-a-repo',
    });
    mocks.git.branchList.mockResolvedValue({ ok: false, error: 'no branches' });
    mocks.git.log.mockResolvedValue({ ok: false, error: 'no log' });

    const { result } = renderHook(() => useGit(DIRECTORY));

    await waitFor(() => expect(result.current.notARepo).toBe(true));
    expect(result.current.status).toBeNull();
    expect(result.current.branches).toEqual([]);
    expect(result.current.log).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('surfaces failed and rejected refreshes without leaving loading active', async () => {
    mocks.git.status.mockResolvedValueOnce({ ok: false, error: 'permission denied' });
    const { result } = renderHook(() => useGit(DIRECTORY));

    await waitFor(() => expect(result.current.error).toBe('permission denied'));
    expect(result.current.notARepo).toBe(false);
    expect(result.current.loading).toBe(false);

    mocks.git.status.mockRejectedValueOnce('renderer closed');
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe('Git operation failed');

    mocks.git.status.mockRejectedValueOnce(new Error('IPC unavailable'));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error).toBe('IPC unavailable');
  });

  it('ignores a retained refresh after unmount and swallows a failed pull reload', async () => {
    const { result, unmount } = renderHook(() => useGit(DIRECTORY));
    await waitFor(() => expect(result.current.status).toEqual(STATUS));
    mocks.loadCollectionFromDirectory.mockRejectedValueOnce(new Error('disk changed'));

    await act(async () => {
      await expect(result.current.pull()).resolves.toBeNull();
    });
    expect(mocks.loadCollectionFromDirectory).toHaveBeenCalledWith(DIRECTORY);

    mocks.git.status.mockClear();
    unmount();
    await act(async () => {
      await result.current.refresh();
    });
    expect(mocks.git.status).not.toHaveBeenCalled();
  });

  it('executes successful actions, refreshes writes, and reloads changed collections', async () => {
    const { result } = renderHook(() => useGit(DIRECTORY));
    await waitFor(() => expect(result.current.status).toEqual(STATUS));
    mocks.git.status.mockClear();
    mocks.loadCollectionFromDirectory.mockRejectedValueOnce(new Error('watcher race'));

    await act(async () => {
      await expect(result.current.init()).resolves.toBeNull();
      await expect(result.current.stage(['request.yaml'])).resolves.toBeNull();
      await expect(result.current.unstage(['request.yaml'])).resolves.toBeNull();
      await expect(result.current.discard(['request.yaml'])).resolves.toBeNull();
      await expect(result.current.diff('request.yaml', true)).resolves.toContain('diff --git');
      await expect(result.current.commit('Update request')).resolves.toBeNull();
      await expect(result.current.createBranch('feature')).resolves.toBeNull();
      await expect(result.current.checkout('feature')).resolves.toBeNull();
      await expect(result.current.fetch()).resolves.toBeNull();
      await expect(result.current.pull()).resolves.toBeNull();
      await expect(result.current.push()).resolves.toBeNull();
    });

    expect(mocks.git.init).toHaveBeenCalledWith(DIRECTORY);
    expect(mocks.git.add).toHaveBeenCalledWith(DIRECTORY, ['request.yaml']);
    expect(mocks.git.unstage).toHaveBeenCalledWith(DIRECTORY, ['request.yaml']);
    expect(mocks.git.discard).toHaveBeenCalledWith(DIRECTORY, ['request.yaml']);
    expect(mocks.git.diff).toHaveBeenCalledWith(DIRECTORY, 'request.yaml', true);
    expect(mocks.git.commit).toHaveBeenCalledWith(DIRECTORY, 'Update request');
    expect(mocks.git.createBranch).toHaveBeenCalledWith(DIRECTORY, 'feature');
    expect(mocks.git.checkoutBranch).toHaveBeenCalledWith(DIRECTORY, 'feature');
    expect(mocks.git.fetch).toHaveBeenCalledWith(DIRECTORY);
    expect(mocks.git.pull).toHaveBeenCalledWith(DIRECTORY);
    expect(mocks.git.push).toHaveBeenCalledWith(DIRECTORY);
    expect(mocks.loadCollectionFromDirectory).toHaveBeenCalledTimes(2);
    expect(mocks.loadCollectionFromDirectory).toHaveBeenNthCalledWith(1, DIRECTORY);
    expect(mocks.loadCollectionFromDirectory).toHaveBeenNthCalledWith(2, DIRECTORY);
    // Every successful mutating/sync action except diff refreshes the read model.
    expect(mocks.git.status).toHaveBeenCalledTimes(10);
  });

  it('returns action errors and does not reload collections for failed syncs', async () => {
    const { result } = renderHook(() => useGit(DIRECTORY));
    await waitFor(() => expect(result.current.status).toEqual(STATUS));
    const failure = { ok: false as const, error: 'operation rejected' };
    mocks.git.init.mockResolvedValue(failure);
    mocks.git.add.mockResolvedValue(failure);
    mocks.git.unstage.mockResolvedValue(failure);
    mocks.git.discard.mockResolvedValue(failure);
    mocks.git.diff.mockResolvedValue(failure);
    mocks.git.commit.mockResolvedValue(failure);
    mocks.git.createBranch.mockResolvedValue(failure);
    mocks.git.checkoutBranch.mockResolvedValue(failure);
    mocks.git.fetch.mockResolvedValue(failure);
    mocks.git.pull.mockResolvedValue(failure);
    mocks.git.push.mockResolvedValue(failure);

    await act(async () => {
      await expect(result.current.init()).resolves.toBe(failure.error);
      await expect(result.current.stage(['request.yaml'])).resolves.toBe(failure.error);
      await expect(result.current.unstage(['request.yaml'])).resolves.toBe(failure.error);
      await expect(result.current.discard(['request.yaml'])).resolves.toBe(failure.error);
      await expect(result.current.diff('request.yaml')).resolves.toBe(failure.error);
      await expect(result.current.commit('Update request')).resolves.toBe(failure.error);
      await expect(result.current.createBranch('feature')).resolves.toBe(failure.error);
      await expect(result.current.checkout('feature')).resolves.toBe(failure.error);
      await expect(result.current.fetch()).resolves.toBe(failure.error);
      await expect(result.current.pull()).resolves.toBe(failure.error);
      await expect(result.current.push()).resolves.toBe(failure.error);
    });

    expect(mocks.git.diff).toHaveBeenCalledWith(DIRECTORY, 'request.yaml', false);
    expect(mocks.loadCollectionFromDirectory).not.toHaveBeenCalled();
  });
});
