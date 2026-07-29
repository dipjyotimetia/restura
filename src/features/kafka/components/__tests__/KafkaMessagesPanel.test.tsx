import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Tabs } from '@/components/ui/tabs';
import type { KafkaConnection, KafkaMessage } from '../../store/useKafkaStore';
import { useKafkaStore } from '../../store/useKafkaStore';
import { KafkaMessagesPanel } from '../KafkaMessagesPanel';

const messages = [
  {
    id: 'activity-1',
    direction: 'system',
    topic: '',
    value: 'Subscribed to orders',
    timestamp: 1,
  },
  {
    id: 'record-1',
    direction: 'received',
    topic: 'orders',
    partition: 0,
    offset: '42',
    value: '',
    tombstone: true,
    timestamp: 2,
  },
] satisfies KafkaMessage[];

const connection: KafkaConnection = {
  id: 'connection-1',
  name: 'Kafka connection',
  clientId: 'restura-test',
  bootstrapBrokers: ['localhost:9092'],
  auth: { securityProtocol: 'PLAINTEXT' },
  status: 'connected',
  defaultTopic: 'orders',
  defaultPartitionKey: '',
  acks: 1,
  compression: 'none',
  idempotent: false,
  consumer: {
    groupId: 'restura-test',
    topics: ['orders'],
    fromBeginning: false,
    mode: 'committed',
    fallbackMode: 'latest',
    commitPolicy: 'manual',
    isolation: 'read-committed',
    groupProtocol: 'classic',
    status: 'subscribed',
  },
  messages,
  createdAt: 0,
};

function MessagesPanel() {
  const [paused, setPaused] = useState(false);
  return (
    <Tabs value="messages">
      <KafkaMessagesPanel connection={connection} paused={paused} onPausedChange={setPaused} />
    </Tabs>
  );
}

describe('KafkaMessagesPanel', () => {
  it('owns view freezing and distinguishes activity from Kafka records', async () => {
    useKafkaStore.setState((state) => ({
      ...state,
      connections: { ...state.connections, [connection.id]: connection },
      messageFilter: 'all',
      searchQuery: '',
    }));
    const user = userEvent.setup();
    render(<MessagesPanel />);

    expect(screen.getByRole('button', { name: 'Freeze message view' })).toBeVisible();
    expect(screen.getByText('Activity')).toBeVisible();
    expect(screen.getByText('Subscribed to orders')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Freeze message view' }));

    expect(screen.getByRole('button', { name: 'Resume live message view' })).toBeVisible();
  });

  it('explains tombstone records in the inspector', async () => {
    useKafkaStore.setState((state) => ({
      ...state,
      connections: { ...state.connections, [connection.id]: connection },
      messageFilter: 'all',
      searchQuery: '',
    }));
    const user = userEvent.setup();
    render(<MessagesPanel />);

    await user.click(screen.getByRole('button', { name: /Kafka record.*offset 42/i }));

    expect(screen.getByText('Tombstone')).toBeVisible();
    expect(screen.getByText(/Kafka null value/)).toBeVisible();
  });
});
