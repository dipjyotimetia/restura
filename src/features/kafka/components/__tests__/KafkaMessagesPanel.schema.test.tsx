import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Tabs } from '@/components/ui/tabs';
import type { KafkaConnection } from '../../store/useKafkaStore';
import { useKafkaStore } from '../../store/useKafkaStore';
import { KafkaMessagesPanel } from '../KafkaMessagesPanel';
import { schemaLabel } from '../shared';

const connection: KafkaConnection = {
  id: 'schema-connection',
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
    commitPolicy: 'auto',
    isolation: 'read-uncommitted',
    groupProtocol: 'classic',
    status: 'subscribed',
  },
  messages: [
    {
      id: 'record-7',
      direction: 'received',
      topic: 'orders',
      partition: 0,
      offset: '7',
      key: 'order-1',
      keySchema: { id: 4 },
      value: '{"id":1}',
      valueSchema: { id: 12, subject: 'orders-value', version: 3 },
      timestamp: 1,
    },
  ],
  createdAt: 0,
};

describe('KafkaMessagesPanel — schema registry labels', () => {
  it('formats schema references with and without subject/version', () => {
    expect(schemaLabel(undefined)).toBe('');
    expect(schemaLabel({ id: 4 })).toBe(' · Schema 4');
    expect(schemaLabel({ id: 12, subject: 'orders-value', version: 3 })).toBe(
      ' · Schema 12 (orders-value v3)'
    );
    expect(schemaLabel({ id: 12, subject: 'orders-value' })).toBe(' · Schema 12 (orders-value)');
  });

  it('shows which schema decoded the key and value of a record', async () => {
    useKafkaStore.setState((state) => ({
      ...state,
      connections: { ...state.connections, [connection.id]: connection },
      messageFilter: 'all',
      searchQuery: '',
    }));
    const user = userEvent.setup();
    render(
      <Tabs value="messages">
        <KafkaMessagesPanel connection={connection} paused={false} onPausedChange={() => {}} />
      </Tabs>
    );

    await user.click(screen.getByRole('button', { name: /Kafka record.*offset 7/i }));

    expect(screen.getByText(/Key · Schema 4$/)).toBeVisible();
    expect(screen.getByText(/Value · Schema 12 \(orders-value v3\)/)).toBeVisible();
  });
});
