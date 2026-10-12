import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useRequestStore } from '@/store/useRequestStore';
import { SaveToCollectionDialog } from './SaveToCollectionDialog';

describe('SaveToCollectionDialog', () => {
  beforeEach(() => {
    useRequestStore.setState({ tabs: [], activeTabId: null, isLoading: false });
    useCollectionStore.setState({ collections: [] });
  });

  it('refuses to store the HTTP placeholder of a WebSocket tab', async () => {
    const user = userEvent.setup();
    const tabId = useRequestStore.getState().openTabWithMode('websocket');
    render(<SaveToCollectionDialog tabId={tabId} open onOpenChange={() => {}} />);

    expect(screen.getByRole('alert')).toHaveTextContent(
      "WebSocket sessions can't be saved to a collection yet"
    );
    await user.type(screen.getByPlaceholderText('New collection name'), 'Sockets');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(useCollectionStore.getState().collections).toHaveLength(0);
  });

  it('saves a collectable tab', async () => {
    const user = userEvent.setup();
    const tabId = useRequestStore.getState().createNewRequest('http');
    render(<SaveToCollectionDialog tabId={tabId} open onOpenChange={() => {}} />);

    expect(screen.queryByRole('alert')).toBeNull();
    await user.type(screen.getByPlaceholderText('New collection name'), 'APIs');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(useCollectionStore.getState().collections[0]?.items).toHaveLength(1);
    expect(useRequestStore.getState().tabs[0]?.savedRequestId).toBeDefined();
  });
});
