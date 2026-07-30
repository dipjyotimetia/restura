import type { GitMergeState } from '@shared/git-types';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
const electronApiMock = vi.hoisted(() => ({ current: null as unknown }));
const useGitMock = vi.hoisted(() => vi.fn());

vi.mock('sonner', () => ({ toast: toastMock }));
vi.mock('@/lib/shared/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/shared/platform')>()),
  getElectronAPI: () => electronApiMock.current,
}));

const git = {
  status: {
    branch: 'feature/collection' as string | null,
    ahead: 2,
    behind: 1,
    clean: false,
    files: [
      { path: 'staged.yml', staged: 'M', unstaged: '.' },
      { path: 'working.yml', staged: '.', unstaged: 'M' },
    ],
  },
  branches: [
    {
      name: 'feature/collection',
      isCurrent: true,
      isRemote: false,
      upstream: 'origin/feature/collection',
    },
  ],
  log: [],
  loading: false,
  error: null as string | null,
  notARepo: false,
  mergeState: {
    phase: 'idle' as const,
    branch: 'feature/collection',
    dirty: false,
  } as GitMergeState,
  refresh: vi.fn(),
  init: vi.fn(),
  stage: vi.fn().mockResolvedValue(null),
  unstage: vi.fn().mockResolvedValue(null),
  discard: vi.fn().mockResolvedValue(null),
  diff: vi.fn().mockResolvedValue('diff --git a/working.yml b/working.yml'),
  commit: vi.fn().mockResolvedValue(null),
  createBranch: vi.fn(),
  checkout: vi.fn(),
  fetch: vi.fn().mockResolvedValue(null),
  pull: vi.fn().mockResolvedValue(null),
  push: vi.fn().mockResolvedValue(null),
  startMerge: vi.fn().mockResolvedValue(null),
  getMergeConflict: vi.fn(),
  resolveMergeConflict: vi.fn().mockResolvedValue(null),
  abortMerge: vi.fn().mockResolvedValue(null),
  completeMerge: vi.fn().mockResolvedValue(null),
};

vi.mock('@/hooks/useGit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useGit')>()),
  useGit: useGitMock,
}));

import { GitDialog } from '../GitDialog';

describe('GitDialog', () => {
  beforeEach(() => {
    electronApiMock.current = null;
    useGitMock.mockReset().mockImplementation(() => git);
    toastMock.error.mockReset();
    toastMock.success.mockReset();
    Object.assign(git, {
      status: {
        branch: 'feature/collection',
        ahead: 2,
        behind: 1,
        clean: false,
        files: [
          { path: 'staged.yml', staged: 'M', unstaged: '.' },
          { path: 'working.yml', staged: '.', unstaged: 'M' },
        ],
      },
      branches: [
        {
          name: 'feature/collection',
          isCurrent: true,
          isRemote: false,
          upstream: 'origin/feature/collection',
          oid: 'a'.repeat(40),
        },
        { name: 'main', isCurrent: false, isRemote: false, oid: 'b'.repeat(40) },
      ],
      log: [
        {
          sha: 'a'.repeat(40),
          abbreviatedSha: 'aaaaaaa',
          author: 'A',
          email: 'a@x',
          timestamp: 0,
          subject: 'Initial',
        },
      ],
      loading: false,
      error: null,
      notARepo: false,
      mergeState: {
        phase: 'idle',
        branch: 'feature/collection',
        dirty: false,
      },
    });
    for (const fn of [
      git.refresh,
      git.init,
      git.stage,
      git.unstage,
      git.discard,
      git.diff,
      git.commit,
      git.createBranch,
      git.checkout,
      git.fetch,
      git.pull,
      git.push,
      git.startMerge,
      git.resolveMergeConflict,
      git.abortMerge,
      git.completeMerge,
    ])
      fn.mockReset().mockResolvedValue(null);
    git.getMergeConflict.mockReset();
  });

  it('separates index and working-tree changes and exposes guarded sync controls', async () => {
    render(
      <GitDialog collectionName="Workspace" directoryPath="/workspace" open onClose={vi.fn()} />
    );

    expect(screen.getByText('origin/feature/collection')).toBeInTheDocument();
    expect(screen.getByText('↑2 ↓1')).toBeInTheDocument();
    expect(screen.getByText('Staged')).toBeInTheDocument();
    expect(screen.getByText('Unstaged')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pull' })).toBeDisabled();
    expect(screen.getByText('Commit index (1 file)')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Stage' }));
    expect(git.stage).toHaveBeenCalledWith(['working.yml']);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Fetch' })).toBeEnabled());
    fireEvent.click(screen.getAllByRole('button', { name: 'Discard' })[1]!);
    expect(screen.getByText('Discard local change?')).toBeInTheDocument();
  });

  it('initialises an untracked workspace and presents errors', async () => {
    git.notARepo = true;
    git.error = 'Git is only available in the desktop app';
    render(
      <GitDialog collectionName="Workspace" directoryPath="/workspace" open onClose={vi.fn()} />
    );
    expect(screen.getByText('Initialize Git repository')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Initialize Git repository'));
    await waitFor(() => expect(git.init).toHaveBeenCalled());
  });

  it('commits the index, changes branches, shows a diff, and syncs', async () => {
    render(
      <GitDialog collectionName="Workspace" directoryPath="/workspace" open onClose={vi.fn()} />
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Commit message' }), {
      target: { value: 'Commit index' },
    });
    fireEvent.click(screen.getByText('Commit index (1 file)'));
    await waitFor(() => expect(git.commit).toHaveBeenCalledWith('Commit index'));
    fireEvent.click(screen.getByText('Unstage'));
    await waitFor(() => expect(git.unstage).toHaveBeenCalledWith(['staged.yml']));
    fireEvent.click(screen.getByText('working.yml'));
    await waitFor(() => expect(git.diff).toHaveBeenCalledWith('working.yml', false));
    fireEvent.click(screen.getByRole('button', { name: 'Fetch' }));
    await waitFor(() => expect(git.fetch).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Push' }));
    await waitFor(() => expect(git.push).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'main' }));
    await waitFor(() => expect(git.checkout).toHaveBeenCalledWith('main'));
    fireEvent.change(screen.getByRole('textbox', { name: 'New branch name' }), {
      target: { value: 'new-branch' },
    });
    fireEvent.click(screen.getByText('Create'));
    await waitFor(() => expect(git.createBranch).toHaveBeenCalledWith('new-branch'));
  });

  it('renders a clean detached workspace and permits a pull', async () => {
    git.status = { branch: null, ahead: 0, behind: 0, clean: true, files: [] };
    git.branches = [];
    git.log = [];
    render(
      <GitDialog collectionName="Workspace" directoryPath="/workspace" open onClose={vi.fn()} />
    );
    expect(screen.getByText('Working tree clean')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pull' }));
    await waitFor(() => expect(git.pull).toHaveBeenCalled());
  });

  it('reports remote sync failures', async () => {
    git.push.mockResolvedValueOnce('remote rejected the branch');
    render(
      <GitDialog collectionName="Workspace" directoryPath="/workspace" open onClose={vi.fn()} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Push' }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith('push failed: remote rejected the branch')
    );
  });

  it('starts a merge from a pinned non-current branch', async () => {
    git.status = { branch: 'feature/collection', ahead: 0, behind: 0, clean: true, files: [] };
    render(
      <GitDialog collectionName="Workspace" directoryPath="/workspace" open onClose={vi.fn()} />
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Merge source' }), {
      target: { value: 'main' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Merge branch' }));

    await waitFor(() => expect(git.startMerge).toHaveBeenCalledWith('main', 'b'.repeat(40)));
    expect(screen.queryByRole('option', { name: 'feature/collection' })).not.toBeInTheDocument();
  });

  it('resumes a structured OpenCollection conflict and submits resolved YAML', async () => {
    const conflict = {
      id: 'conflict-1',
      path: 'requests/get-user.yml',
      relatedPaths: ['requests/get-user.yml'],
      status: 'both-modified' as const,
      kind: 'text' as const,
      openCollectionKind: 'request' as const,
    };
    git.mergeState = {
      phase: 'conflicted',
      branch: 'feature/collection',
      mergeHead: 'c'.repeat(40),
      conflicts: [conflict],
      suggestedMessage: "Merge branch 'main'",
    };
    git.getMergeConflict.mockResolvedValue({
      ...conflict,
      strategy: 'structured',
      base: { present: true, content: 'type: http\nname: User\nurl: /v1\n' },
      local: { present: true, content: 'type: http\nname: User\nurl: /local\n' },
      incoming: { present: true, content: 'type: http\nname: User\nurl: /incoming\n' },
      proposedContent: 'type: http\nname: User\nurl: /local\n',
      structured: {
        result: { type: 'http', name: 'User', url: '/local' },
        conflicts: [
          {
            path: '/url',
            base: { present: true, value: '/v1' },
            local: { present: true, value: '/local' },
            incoming: { present: true, value: '/incoming' },
          },
        ],
      },
    });

    render(
      <GitDialog collectionName="Workspace" directoryPath="/workspace" open onClose={vi.fn()} />
    );
    expect(screen.getByText('Merge interrupted')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /requests\/get-user.yml/ }));
    expect(await screen.findByText('/url')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use incoming for /url' }));
    fireEvent.click(screen.getByRole('button', { name: 'Resolve file' }));

    await waitFor(() =>
      expect(git.resolveMergeConflict).toHaveBeenCalledWith(
        expect.objectContaining({
          conflictId: 'conflict-1',
          kind: 'content',
          content: expect.stringContaining('/incoming'),
        })
      )
    );
  });

  it('offers choice-only resolution and marks submodules for external handling', async () => {
    const binaryConflict = {
      id: 'binary-1',
      path: 'asset.bin',
      relatedPaths: ['asset.bin'],
      status: 'both-modified' as const,
      kind: 'binary' as const,
    };
    git.mergeState = {
      phase: 'conflicted',
      branch: 'feature/collection',
      mergeHead: 'd'.repeat(40),
      conflicts: [binaryConflict],
      suggestedMessage: 'Merge binary',
    };
    git.getMergeConflict.mockResolvedValue({
      ...binaryConflict,
      strategy: 'choice-only',
      base: { present: true },
      local: { present: true },
      incoming: { present: true },
    });

    const { rerender } = render(
      <GitDialog collectionName="Workspace" directoryPath="/workspace" open onClose={vi.fn()} />
    );
    fireEvent.click(screen.getByRole('button', { name: /asset.bin/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use incoming file' }));
    await waitFor(() =>
      expect(git.resolveMergeConflict).toHaveBeenCalledWith({
        conflictId: 'binary-1',
        kind: 'choice',
        choice: 'incoming',
      })
    );

    const submoduleConflict = {
      ...binaryConflict,
      id: 'submodule-1',
      path: 'vendor/module',
      relatedPaths: ['vendor/module'],
      kind: 'submodule' as const,
    };
    git.mergeState = {
      ...git.mergeState,
      conflicts: [submoduleConflict],
    };
    git.getMergeConflict.mockResolvedValue({
      ...submoduleConflict,
      strategy: 'unsupported',
      base: { present: true },
      local: { present: true },
      incoming: { present: true },
    });
    rerender(
      <GitDialog collectionName="Workspace" directoryPath="/workspace" open onClose={vi.fn()} />
    );
    fireEvent.click(screen.getByRole('button', { name: /vendor\/module/ }));
    expect(
      await screen.findByText(/Resolve this submodule with Git outside Restura/)
    ).toBeInTheDocument();
  });

  it('requires confirmation to abort and an explicit message to complete a merge', async () => {
    git.status = { branch: 'feature/collection', ahead: 0, behind: 0, clean: false, files: [] };
    git.mergeState = {
      phase: 'ready-to-commit',
      branch: 'feature/collection',
      mergeHead: 'e'.repeat(40),
      suggestedMessage: "Merge branch 'main'",
    };
    render(
      <GitDialog collectionName="Workspace" directoryPath="/workspace" open onClose={vi.fn()} />
    );

    const commitButton = screen.getByRole('button', { name: 'Commit merge' });
    expect(commitButton).toBeEnabled();
    fireEvent.click(commitButton);
    await waitFor(() => expect(git.completeMerge).toHaveBeenCalledWith("Merge branch 'main'"));

    fireEvent.click(screen.getByRole('button', { name: 'Abort merge' }));
    expect(screen.getByText('Abort merge?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Abort' }));
    await waitFor(() => expect(git.abortMerge).toHaveBeenCalled());
  });

  it('keeps the reopened directory visible when the closed directory resolves last', async () => {
    const { useGit: useActualGit } =
      await vi.importActual<typeof import('@/hooks/useGit')>('@/hooks/useGit');
    const directoryA = deferred<GitStatusResult>();
    const directoryB = deferred<GitStatusResult>();
    const status = vi.fn((directoryPath: string) =>
      directoryPath === '/workspace-a' ? directoryA.promise : directoryB.promise
    );
    electronApiMock.current = {
      git: {
        status,
        branchList: vi.fn(async (directoryPath: string) => ({
          ok: true as const,
          branches: [
            {
              name: directoryPath === '/workspace-a' ? 'branch-a' : 'branch-b',
              isCurrent: true,
              isRemote: false,
            },
          ],
        })),
        log: vi.fn(async () => ({ ok: true as const, commits: [] })),
        mergeState: vi.fn(async (directoryPath: string) => ({
          ok: true as const,
          state: {
            phase: 'idle' as const,
            branch: directoryPath === '/workspace-a' ? 'branch-a' : 'branch-b',
            dirty: false,
          },
        })),
      },
    };
    useGitMock.mockImplementation(useActualGit);

    const { rerender } = render(
      <GitDialog collectionName="Workspace A" directoryPath="/workspace-a" open onClose={vi.fn()} />
    );
    await waitFor(() => expect(status).toHaveBeenCalledWith('/workspace-a'));

    rerender(
      <GitDialog
        collectionName="Workspace A"
        directoryPath="/workspace-a"
        open={false}
        onClose={vi.fn()}
      />
    );
    rerender(
      <GitDialog collectionName="Workspace B" directoryPath="/workspace-b" open onClose={vi.fn()} />
    );
    await waitFor(() => expect(status).toHaveBeenCalledWith('/workspace-b'));

    await act(async () => {
      directoryB.resolve(statusResult('branch-b'));
      await directoryB.promise;
    });
    expect(await screen.findAllByText('branch-b')).toHaveLength(2);

    await act(async () => {
      directoryA.resolve(statusResult('branch-a'));
      await directoryA.promise;
    });
    expect(screen.getAllByText('branch-b')).toHaveLength(2);
    expect(screen.queryAllByText('branch-a')).toHaveLength(0);
  });
});

type GitStatusResult = {
  ok: true;
  status: {
    branch: string;
    ahead: number;
    behind: number;
    clean: boolean;
    files: [];
  };
};

function statusResult(branch: string): GitStatusResult {
  return {
    ok: true,
    status: { branch, ahead: 0, behind: 0, clean: true, files: [] },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
