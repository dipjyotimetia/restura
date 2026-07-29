import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { KafkaConnection } from '../../store/useKafkaStore';
import KafkaClient from '../KafkaClient';

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
    commitPolicy: 'auto',
    isolation: 'read-uncommitted',
    groupProtocol: 'classic',
    status: 'subscribed',
  },
  messages: [],
  createdAt: 0,
};

vi.mock('../../hooks/useKafkaConnection', () => ({
  useKafkaConnection: () => ({
    isDesktop: true,
    activeConnectionId: connection.id,
    connection,
    removeConnection: vi.fn(),
    updateConnection: vi.fn(),
    updateConsumer: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  }),
}));

vi.mock('../KafkaConnectionForm', () => ({
  KafkaConnectionForm: () => null,
}));
vi.mock('../KafkaProducerPanel', () => ({
  KafkaProducerPanel: () => null,
}));
vi.mock('../KafkaConsumerPanel', () => ({
  CONSUME_MODE_OPTIONS: [],
  KafkaConsumerPanel: () => null,
}));
vi.mock('../KafkaMessagesPanel', () => ({
  KafkaMessagesPanel: () => null,
}));
vi.mock('../KafkaAdminPanel', () => ({
  KafkaAdminPanel: () => null,
}));

describe('KafkaClient shell', () => {
  it('keeps connection-wide status in the header without consumer or view controls', () => {
    render(<KafkaClient />);

    expect(
      screen.getByRole('status', { name: 'Kafka connection status: Connected' })
    ).toBeVisible();
    expect(screen.queryByLabelText('Consume start position')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /freeze/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Subscribed')).not.toBeInTheDocument();
  });
});
