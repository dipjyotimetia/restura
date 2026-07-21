import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const git = {
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
  ],
  log: [],
  loading: false,
  error: null,
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
});
