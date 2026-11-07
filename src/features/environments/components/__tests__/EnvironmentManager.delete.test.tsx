import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import EnvironmentManager from '../EnvironmentManager';

const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

describe('EnvironmentManager delete', () => {
  beforeEach(() => {
    toastMock.error.mockReset();
    useEnvironmentStore.setState({
      environments: [
        { id: 'base', name: 'Shared', variables: [] },
        { id: 'dev', name: 'Dev', parentId: 'base', variables: [] },
        { id: 'solo', name: 'Solo', variables: [] },
      ],
      activeEnvironmentId: null,
    });
  });

  it('refuses up front to delete a base environment that still owns sub-environments', () => {
    render(<EnvironmentManager open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Shared' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining('Remove its 1 sub-environment first')
    );
    expect(useEnvironmentStore.getState().environments).toHaveLength(3);
  });

  it('names the environment in the confirm and deletes it', () => {
    render(<EnvironmentManager open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Solo' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('"Solo"');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(useEnvironmentStore.getState().environments.map((e) => e.id)).toEqual(['base', 'dev']);
  });
});
