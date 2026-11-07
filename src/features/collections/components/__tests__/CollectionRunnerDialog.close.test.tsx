import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCollectionStore } from '@/store/useCollectionStore';
import { CollectionRunnerDialog } from '../CollectionRunnerDialog';

const stop = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useCollectionRun', () => ({
  useCollectionRun: () => ({ running: true, progress: null, start: vi.fn(), stop }),
}));

describe('CollectionRunnerDialog close while running', () => {
  beforeEach(() => {
    stop.mockReset();
    useCollectionStore.setState({ collections: [{ id: 'c', name: 'API', items: [] }] });
  });

  it('explains why it stays open and offers Stop & close', () => {
    const onClose = vi.fn();
    render(<CollectionRunnerDialog scope={{ collectionId: 'c' }} onClose={onClose} />);
    expect(screen.queryByText('Stop the run to close this dialog.')).toBeNull();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('Stop the run to close this dialog.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Stop & close' }));
    expect(stop).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
