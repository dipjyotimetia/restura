import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
};

vi.mock('@/hooks/useGit', () => ({ useGit: () => git }));

import { GitDialog } from '../GitDialog';

describe('GitDialog', () => {
  beforeEach(() => {
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
        },
        { name: 'main', isCurrent: false, isRemote: false },
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
    ])
      fn.mockReset().mockResolvedValue(null);
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
});
