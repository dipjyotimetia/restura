import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Tabs } from '@/components/ui/tabs';
import type { KafkaConnection } from '../../store/useKafkaStore';
import { KafkaAdminPanel } from '../KafkaAdminPanel';

const manager = vi.hoisted(() => ({
  listTopics: vi.fn(),
  listGroups: vi.fn(),
  createTopic: vi.fn(),
  deleteTopic: vi.fn(),
}));

vi.mock('@/features/kafka/lib/kafkaManager', () => ({
  kafkaManager: manager,
}));

vi.mock('../KafkaAdvancedAdmin', () => ({
  KafkaAdvancedAdmin: () => null,
}));

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
    topics: [],
    fromBeginning: false,
    mode: 'committed',
    fallbackMode: 'latest',
    commitPolicy: 'auto',
    isolation: 'read-uncommitted',
    groupProtocol: 'classic',
    status: 'idle',
  },
  messages: [],
  createdAt: 0,
};

describe('KafkaAdminPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    manager.listTopics.mockResolvedValue({
      ok: true,
      topics: ['orders', 'payments', 'audit'],
    });
  });

  it('counts and filters loaded topics with a meaningful no-match state', async () => {
    const user = userEvent.setup();
    render(
      <Tabs value="admin">
        <KafkaAdminPanel connection={connection} />
      </Tabs>
    );

    await user.click(screen.getByRole('button', { name: 'List topics' }));

    expect(await screen.findByText('3 topics')).toBeVisible();
    const filter = screen.getByRole('searchbox', { name: 'Filter topics' });
    await user.type(filter, 'pay');
    expect(screen.getByText('payments')).toBeVisible();
    expect(screen.queryByText('orders')).not.toBeInTheDocument();
    expect(screen.getByText('1 of 3 topics')).toBeVisible();

    await user.clear(filter);
    await user.type(filter, 'missing');
    expect(screen.getByText('No topics match “missing”.')).toBeVisible();
  });

  it('uses explicit topic field labels and destructive delete affordances', async () => {
    const user = userEvent.setup();
    render(
      <Tabs value="admin">
        <KafkaAdminPanel connection={connection} />
      </Tabs>
    );

    expect(screen.getByLabelText('Topic name')).toBeVisible();
    expect(screen.getByLabelText('Partitions')).toBeVisible();
    expect(screen.getByLabelText('Replication factor')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'List topics' }));
    const deleteButton = await screen.findByRole('button', { name: 'Delete topic orders' });
    expect(deleteButton).toHaveClass('bg-destructive');
    expect(screen.getByRole('button', { name: 'Inspect topic orders' })).toBeVisible();
  });

  it('announces topic loading while discovery is in flight', async () => {
    manager.listTopics.mockReturnValueOnce(new Promise(() => {}));
    const user = userEvent.setup();
    render(
      <Tabs value="admin">
        <KafkaAdminPanel connection={connection} />
      </Tabs>
    );

    await user.click(screen.getByRole('button', { name: 'List topics' }));

    expect(screen.getByRole('status')).toHaveTextContent('Loading topics');
  });
});
