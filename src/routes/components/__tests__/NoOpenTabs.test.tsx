import { fireEvent, render, screen } from '@testing-library/react';
import { FolderPlus } from 'lucide-react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarEmptyState } from '@/features/collections/components/SidebarEmptyState';
import { useCollectionStore } from '@/store/useCollectionStore';
import { NoOpenTabs } from '../NoOpenTabs';

vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));

describe('sample collection entry points', () => {
  beforeEach(() => useCollectionStore.setState({ collections: [] }));

  it('NoOpenTabs offers the sample only while there are no collections', () => {
    const { rerender } = render(<NoOpenTabs onNewRequest={vi.fn()} onOpenImport={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try sample collection' }));
    expect(useCollectionStore.getState().collections).toHaveLength(1);
    rerender(<NoOpenTabs onNewRequest={vi.fn()} onOpenImport={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Try sample collection' })).toBeNull();
  });

  it('SidebarEmptyState renders an optional action', () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <SidebarEmptyState icon={FolderPlus} title="t" hint="h" action={{ label: 'Go', onClick }} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onClick).toHaveBeenCalledOnce();
    rerender(<SidebarEmptyState icon={FolderPlus} title="t" hint="h" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
