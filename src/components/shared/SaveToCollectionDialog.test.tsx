import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useKafkaStore } from '@/features/kafka/store/useKafkaStore';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useRequestStore } from '@/store/useRequestStore';
import { SaveToCollectionDialog } from './SaveToCollectionDialog';

vi.mock('@/lib/shared/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shared/platform')>();
  return { ...actual, isElectron: () => true };
});
vi.mock('@/lib/shared/secure-storage', () => ({
  secureStorage: {
    get: () => null,
    getAsync: async () => null,
    set: () => {},
    remove: () => {},
  },
}));

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

  it('saves a Kafka tab as a secret-free connection preset (#984)', async () => {
    const user = userEvent.setup();
    const tabId = useRequestStore.getState().openTabWithMode('kafka');
    const connectionId = useKafkaStore.getState().ensureConnectionForTab(tabId);
    useKafkaStore.getState().updateConnection(connectionId, {
      bootstrapBrokers: ['{{host}}:9092'],
      defaultTopic: 'orders',
    });
    render(<SaveToCollectionDialog tabId={tabId} open onOpenChange={() => {}} />);

    expect(screen.queryByRole('alert')).toBeNull();
    await user.clear(screen.getByPlaceholderText('Request name'));
    await user.type(screen.getByPlaceholderText('Request name'), 'Orders');
    await user.type(screen.getByPlaceholderText('New collection name'), 'Brokers');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const saved = useCollectionStore.getState().collections[0]?.items[0];
    expect(saved).toMatchObject({
      name: 'Orders',
      request: {
        type: 'kafka',
        name: 'Orders',
        connection: { bootstrapBrokers: ['{{host}}:9092'] },
        produce: { topic: 'orders' },
      },
    });
    expect(useRequestStore.getState().tabs[0]?.savedRequestId).toBe(saved?.id);
  });

  it('asks to open the panel first when a Kafka tab has no connection yet', async () => {
    const user = userEvent.setup();
    const tabId = useRequestStore.getState().openTabWithMode('kafka');
    render(<SaveToCollectionDialog tabId={tabId} open onOpenChange={() => {}} />);
    await user.type(screen.getByPlaceholderText('New collection name'), 'Brokers');
    await user.click(screen.getByRole('button', { name: 'Save' }));
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
