import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KafkaConnection } from '../../store/useKafkaStore';
import KafkaClient from '../KafkaClient';

const mocks = vi.hoisted(() => ({
  produce: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  pauseConsumer: vi.fn(),
  resumeConsumer: vi.fn(),
  removeConnection: vi.fn(),
  updateConnection: vi.fn(),
  updateConsumer: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  connection: null as KafkaConnection | null,
  isDesktop: true,
}));

vi.mock('@/features/kafka/lib/kafkaManager', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/features/kafka/lib/kafkaManager')>();
  return {
    ...original,
    kafkaManager: {
      ...original.kafkaManager,
      produce: mocks.produce,
      subscribe: mocks.subscribe,
      unsubscribe: mocks.unsubscribe,
    },
  };
});

vi.mock('../../hooks/useKafkaConnection', () => ({
  useKafkaConnection: () => ({
    isDesktop: mocks.isDesktop,
    activeConnectionId: mocks.connection?.id ?? null,
    connection: mocks.connection,
    removeConnection: mocks.removeConnection,
    updateConnection: mocks.updateConnection,
    updateConsumer: mocks.updateConsumer,
    connect: mocks.connect,
    disconnect: mocks.disconnect,
  }),
}));

vi.mock('../KafkaConnectionForm', () => ({
  KafkaConnectionForm: () => null,
}));
vi.mock('../KafkaAdminPanel', () => ({
  KafkaAdminPanel: () => null,
}));
vi.mock('../KafkaMessagesPanel', () => ({
  KafkaMessagesPanel: ({ onPausedChange }: { onPausedChange: (paused: boolean) => void }) => (
    <button type="button" onClick={() => onPausedChange(true)}>
      Pause view from panel
    </button>
  ),
}));
vi.mock('../KafkaProducerPanel', () => ({
  KafkaProducerPanel: (props: {
    setProduceKey: (value: string) => void;
    setProduceKeyEncoding: (value: 'json') => void;
    setProduceValue: (value: string) => void;
    setProduceValueEncoding: (value: 'json') => void;
    setProduceHeaders: (
      value: Array<{ id: string; key: string; value: string; enabled: boolean }>
    ) => void;
    setProducePartition: (value: string) => void;
    setProduceSchemaId: (value: string) => void;
    setProduceKeySchemaId: (value: string) => void;
    setProduceTombstone: (value: boolean) => void;
    onPublish: () => void;
  }) => (
    <div>
      <button
        type="button"
        onClick={() => {
          props.setProduceKey('{"id":1}');
          props.setProduceKeyEncoding('json');
          props.setProduceValue('{"event":"created"}');
          props.setProduceValueEncoding('json');
          props.setProduceHeaders([{ id: 'header-1', key: 'trace', value: 'abc', enabled: true }]);
          props.setProducePartition('2');
          props.setProduceSchemaId('1');
          props.setProduceKeySchemaId('2');
        }}
      >
        Configure structured record
      </button>
      <button type="button" onClick={() => props.setProduceTombstone(true)}>
        Configure tombstone
      </button>
      <button type="button" onClick={props.onPublish}>
        Publish from panel
      </button>
    </div>
  ),
}));
vi.mock('../KafkaConsumerPanel', () => ({
  CONSUME_MODE_OPTIONS: [],
  KafkaConsumerPanel: (props: {
    setTopicDraft: (value: string) => void;
    onAddTopic: () => void;
    onRemoveTopic: (index: number) => void;
    onConsumeModeChange: (mode: 'earliest' | 'from-offset' | 'from-timestamp') => void;
    setOffsetPartition: (value: string) => void;
    setOffsetValue: (value: string) => void;
    setTimestampDraft: (value: string) => void;
    onSubscribe: () => void;
    onUnsubscribe: () => void;
    onPause: () => void;
    onResume: () => void;
  }) => (
    <div>
      <button type="button" onClick={() => props.setTopicDraft('payments')}>
        Draft topic
      </button>
      <button type="button" onClick={props.onAddTopic}>
        Add drafted topic
      </button>
      <button type="button" onClick={() => props.onRemoveTopic(0)}>
        Remove first topic
      </button>
      <button type="button" onClick={() => props.onConsumeModeChange('earliest')}>
        Earliest mode
      </button>
      <button
        type="button"
        onClick={() => {
          props.onConsumeModeChange('from-offset');
          props.setOffsetPartition('1');
          props.setOffsetValue('42');
        }}
      >
        Manual mode
      </button>
      <button
        type="button"
        onClick={() => {
          props.onConsumeModeChange('from-timestamp');
          props.setTimestampDraft('2026-07-29T00:00:00.000Z');
        }}
      >
        Timestamp mode
      </button>
      <button type="button" onClick={props.onSubscribe}>
        Subscribe from panel
      </button>
      <button type="button" onClick={props.onUnsubscribe}>
        Unsubscribe from panel
      </button>
      <button type="button" onClick={props.onPause}>
        Pause consumer from panel
      </button>
      <button type="button" onClick={props.onResume}>
        Resume consumer from panel
      </button>
    </div>
  ),
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
  acks: -1,
  compression: 'gzip',
  idempotent: true,
  registry: { url: 'https://registry.example.test' },
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
  messages: [],
  createdAt: 0,
};

describe('KafkaClient orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connection = connection;
    mocks.isDesktop = true;
    mocks.produce.mockResolvedValue({ ok: true });
    mocks.subscribe.mockResolvedValue({ ok: true });
    mocks.unsubscribe.mockResolvedValue(undefined);
    mocks.pauseConsumer.mockResolvedValue({ success: true });
    mocks.resumeConsumer.mockResolvedValue({ success: true });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        kafka: {
          pauseConsumer: mocks.pauseConsumer,
          resumeConsumer: mocks.resumeConsumer,
        },
      },
    });
  });

  it('builds structured producer records and true tombstones through the shared manager', async () => {
    const user = userEvent.setup();
    render(<KafkaClient />);

    await user.click(screen.getByRole('button', { name: 'Configure structured record' }));
    await user.click(screen.getByRole('button', { name: 'Publish from panel' }));
    expect(mocks.produce).toHaveBeenLastCalledWith({
      connectionId: connection.id,
      topic: 'orders',
      key: '{"id":1}',
      keyEncoding: 'utf8',
      value: '{"event":"created"}',
      valueEncoding: 'utf8',
      acks: -1,
      compression: 'gzip',
      headers: { trace: 'abc' },
      partition: 2,
      valueSchemaId: 1,
      keySchemaId: 2,
    });

    await user.click(screen.getByRole('button', { name: 'Configure tombstone' }));
    await user.click(screen.getByRole('button', { name: 'Publish from panel' }));
    expect(mocks.produce).toHaveBeenLastCalledWith(
      expect.objectContaining({ value: null, topic: 'orders' })
    );
  });

  it('maps consumer modes and delegates add, remove, subscribe, pause, resume, and unsubscribe', async () => {
    const user = userEvent.setup();
    render(<KafkaClient />);

    await user.click(screen.getByRole('button', { name: 'Draft topic' }));
    await user.click(screen.getByRole('button', { name: 'Add drafted topic' }));
    expect(mocks.updateConsumer).toHaveBeenCalledWith(connection.id, {
      topics: ['orders', 'payments'],
    });
    await user.click(screen.getByRole('button', { name: 'Remove first topic' }));
    expect(mocks.updateConsumer).toHaveBeenCalledWith(connection.id, { topics: [] });

    await user.click(screen.getByRole('button', { name: 'Earliest mode' }));
    expect(mocks.updateConsumer).toHaveBeenCalledWith(connection.id, {
      mode: 'earliest',
      fromBeginning: true,
    });
    await user.click(screen.getByRole('button', { name: 'Manual mode' }));
    await user.click(screen.getByRole('button', { name: 'Subscribe from panel' }));
    expect(mocks.subscribe).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mode: 'manual',
        offsets: [{ topic: 'orders', partition: 1, offset: '42' }],
      })
    );
    await user.click(screen.getByRole('button', { name: 'Timestamp mode' }));
    await user.click(screen.getByRole('button', { name: 'Subscribe from panel' }));
    expect(mocks.subscribe).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mode: 'timestamp',
        timestamp: String(new Date('2026-07-29T00:00:00.000Z').getTime()),
      })
    );

    await user.click(screen.getByRole('button', { name: 'Pause consumer from panel' }));
    await user.click(screen.getByRole('button', { name: 'Resume consumer from panel' }));
    await user.click(screen.getByRole('button', { name: 'Unsubscribe from panel' }));
    await act(async () => {});
    expect(mocks.pauseConsumer).toHaveBeenCalledWith({ connectionId: connection.id });
    expect(mocks.resumeConsumer).toHaveBeenCalledWith({ connectionId: connection.id });
    expect(mocks.unsubscribe).toHaveBeenCalledWith(connection.id);
  });

  it('renders the native desktop guidance when Kafka is unavailable in the browser', () => {
    mocks.isDesktop = false;
    render(<KafkaClient />);
    expect(screen.getByText('Kafka is a desktop-only feature')).toBeVisible();
  });
});
