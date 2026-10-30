import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useKafkaStore } from '@/features/kafka/store/useKafkaStore';
import { useWebSocketStore } from '@/features/websocket/store/useWebSocketStore';
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

  it('saves a WebSocket tab as a WebSocket collection item, not its HTTP placeholder (#1209)', async () => {
    const user = userEvent.setup();
    const tabId = useRequestStore.getState().openTabWithMode('websocket');
    const connectionId = useWebSocketStore
      .getState()
      .ensureConnectionForTab(tabId, 'wss://{{host}}/feed');
    useWebSocketStore.getState().setProtocols(connectionId, ['json']);
    render(<SaveToCollectionDialog tabId={tabId} open onOpenChange={() => {}} />);

    expect(screen.queryByRole('alert')).toBeNull();
    await user.clear(screen.getByPlaceholderText('Request name'));
    await user.type(screen.getByPlaceholderText('Request name'), 'Feed');
    await user.type(screen.getByPlaceholderText('New collection name'), 'Sockets');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const saved = useCollectionStore.getState().collections[0]?.items[0];
    expect(saved).toMatchObject({
      name: 'Feed',
      type: 'request',
      request: { type: 'websocket', name: 'Feed', url: 'wss://{{host}}/feed', protocols: ['json'] },
    });
    expect(useRequestStore.getState().tabs[0]?.savedRequestId).toBe(saved?.id);
  });

  it('refuses a Socket.IO tab whose panel never created a connection', async () => {
    const user = userEvent.setup();
    const tabId = useRequestStore.getState().openTabWithMode('socketio');
    render(<SaveToCollectionDialog tabId={tabId} open onOpenChange={() => {}} />);
    await user.type(screen.getByPlaceholderText('New collection name'), 'Sockets');
    await user.click(screen.getByRole('button', { name: 'Save' }));
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
