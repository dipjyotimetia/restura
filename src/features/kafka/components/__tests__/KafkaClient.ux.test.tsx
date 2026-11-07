import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Tabs } from '@/components/ui/tabs';
import type { KafkaConnection } from '../../store/useKafkaStore';
import { useKafkaStore } from '../../store/useKafkaStore';
import KafkaClient from '../KafkaClient';
import { KafkaMessagesPanel } from '../KafkaMessagesPanel';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
  removeConnection: vi.fn(),
  connection: null as KafkaConnection | null,
}));

vi.mock('../../hooks/useKafkaConnection', () => ({
  useKafkaConnection: () => ({
    isDesktop: true,
    activeConnectionId: mocks.connection?.id ?? null,
    connection: mocks.connection,
    removeConnection: mocks.removeConnection,
    updateConnection: vi.fn(),
    updateConsumer: vi.fn(),
    connect: mocks.connect,
    disconnect: mocks.disconnect,
  }),
}));
vi.mock('../KafkaConnectionForm', () => ({ KafkaConnectionForm: () => null }));
vi.mock('../KafkaAdminPanel', () => ({ KafkaAdminPanel: () => null }));
vi.mock('../KafkaConsumerPanel', () => ({
  CONSUME_MODE_OPTIONS: [],
  KafkaConsumerPanel: () => null,
}));

function makeConnection(): KafkaConnection {
  const id = useKafkaStore.getState().ensureConnectionForTab(`tab-${Math.random()}`);
  return useKafkaStore.getState().connections[id] as KafkaConnection;
}

function live(id: string): KafkaConnection {
  return useKafkaStore.getState().connections[id] as KafkaConnection;
}

function Panel({ id }: { id: string }) {
  const [paused, setPaused] = useState(false);
  const conn = useKafkaStore((s) => s.connections[id]) as KafkaConnection;
  return (
    <Tabs defaultValue="messages">
      <KafkaMessagesPanel connection={conn} paused={paused} onPausedChange={setPaused} />
    </Tabs>
  );
}

const record = (value: string) => ({
  direction: 'received' as const,
  topic: 'orders',
  value,
  partition: 0,
  offset: '1',
});

beforeEach(() => {
  vi.clearAllMocks();
  useKafkaStore.setState({
    connections: {},
    connectionByTabId: {},
    messageFilter: 'all',
    searchQuery: '',
  });
});

describe('KafkaClient connection bar', () => {
  it('shows the connect error inline until the next attempt (S3)', async () => {
    const conn = makeConnection();
    mocks.connection = conn;
    mocks.connect.mockImplementationOnce(async () => {
      useKafkaStore.getState().addMessage(conn.id, {
        direction: 'system',
        topic: '',
        value: 'Broker unreachable',
        error: 'Broker unreachable',
      });
      mocks.connection = live(conn.id);
    });
    const { rerender } = render(<KafkaClient />);
    fireEvent.click(screen.getByRole('button', { name: /^Connect$/ }));
    await waitFor(() => expect(mocks.connect).toHaveBeenCalled());
    rerender(<KafkaClient />);
    expect((await screen.findByRole('alert')).textContent).toContain('Broker unreachable');
  });

  it('disables Connect while connecting (S3)', () => {
    const conn = makeConnection();
    mocks.connection = { ...conn, status: 'connecting' };
    render(<KafkaClient />);
    expect(screen.getByRole('button', { name: /Connecting/ })).toBeDisabled();
  });

  it('confirms and disconnects before deleting (S4)', async () => {
    const conn = makeConnection();
    mocks.connection = { ...conn, status: 'connected' };
    render(<KafkaClient />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete connection' }));
    expect(mocks.removeConnection).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mocks.removeConnection).toHaveBeenCalledWith(conn.id));
    expect(mocks.disconnect).toHaveBeenCalled();
  });
});

describe('KafkaMessagesPanel', () => {
  it('uses the shared freeze toggle with a new-message count and filter-aware empty state (S7, S12)', () => {
    const conn = makeConnection();
    act(() => {
      useKafkaStore.getState().addMessage(conn.id, record('first'));
    });
    render(<Panel id={conn.id} />);
    fireEvent.click(screen.getByRole('button', { name: 'Freeze message view' }));
    act(() => {
      useKafkaStore
        .getState()
        .addMessage(conn.id, { ...record('second'), timestamp: Date.now() + 1000 });
    });
    expect(screen.queryByText('second')).toBeNull();
    expect(screen.getByText('1 new')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search messages' }), {
      target: { value: 'zzz' },
    });
    expect(screen.getByText('No messages match the current filter.')).toBeTruthy();
  });

  it('reports messages dropped by the cap and labels its controls (S8, S9)', () => {
    const conn = makeConnection();
    act(() => {
      useKafkaStore.getState().addMessages(
        conn.id,
        Array.from({ length: 1001 }, (_, i) => record(String(i)))
      );
    });
    render(<Panel id={conn.id} />);
    expect(screen.getByText('Showing last 1,000 — 1 older dropped')).toBeTruthy();
    expect(screen.getByRole('log', { name: 'Kafka messages' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Filter messages' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear messages' }));
    expect(live(conn.id).messages).toEqual([]);
    expect(live(conn.id).droppedCount).toBe(0);
  });
});
