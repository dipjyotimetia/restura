import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KafkaConnection } from '../../store/useKafkaStore';
import KafkaClient from '../KafkaClient';

// biome-ignore lint/suspicious/noExplicitAny: captured props of mocked child panels
type AnyProps = Record<string, any>;

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
  activeConnectionId: null as string | null,
  producer: {} as Record<string, unknown>,
  consumer: {} as Record<string, unknown>,
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
    isDesktop: true,
    activeConnectionId: mocks.activeConnectionId,
    connection: mocks.connection,
    removeConnection: mocks.removeConnection,
    updateConnection: mocks.updateConnection,
    updateConsumer: mocks.updateConsumer,
    connect: mocks.connect,
    disconnect: mocks.disconnect,
  }),
}));
vi.mock('../KafkaConnectionForm', () => ({ KafkaConnectionForm: () => null }));
vi.mock('../KafkaAdminPanel', () => ({ KafkaAdminPanel: () => null }));
vi.mock('../KafkaMessagesPanel', () => ({ KafkaMessagesPanel: () => null }));
vi.mock('../KafkaProducerPanel', () => ({
  KafkaProducerPanel: (props: Record<string, unknown>) => {
    mocks.producer = props;
    return null;
  },
}));
vi.mock('../KafkaConsumerPanel', () => ({
  CONSUME_MODE_OPTIONS: [],
  KafkaConsumerPanel: (props: Record<string, unknown>) => {
    mocks.consumer = props;
    return null;
  },
}));

const base: KafkaConnection = {
  id: 'c0',
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
    groupId: 'g',
    topics: ['orders'],
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

let seq = 0;
let currentId = 'c0';
function setConn(patch: Partial<KafkaConnection> = {}): void {
  mocks.connection = { ...base, id: currentId, ...patch };
  mocks.activeConnectionId = mocks.connection.id;
}
const producer = (): AnyProps => mocks.producer as AnyProps;
const consumer = (): AnyProps => mocks.consumer as AnyProps;
const errorText = (): unknown => producer().produceError;

describe('KafkaClient branches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seq += 1;
    currentId = `c${seq}`;
    mocks.produce.mockResolvedValue({ ok: true });
    mocks.subscribe.mockResolvedValue({ ok: true });
    mocks.unsubscribe.mockResolvedValue(undefined);
    setConn();
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        kafka: { pauseConsumer: mocks.pauseConsumer, resumeConsumer: mocks.resumeConsumer },
      },
    });
  });

  describe('header', () => {
    it('shows an empty state with no connection and no header controls', () => {
      mocks.connection = null;
      mocks.activeConnectionId = null;
      render(<KafkaClient />);
      expect(screen.getByText(/No connection/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Connect/ })).not.toBeInTheDocument();
    });

    it('shows Connect and a connecting badge while connecting, wiring delete and connect', async () => {
      setConn({ status: 'connecting' });
      const user = userEvent.setup();
      render(<KafkaClient />);
      expect(screen.getByLabelText('Kafka connection status: Connecting')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /Connect/ }));
      expect(mocks.connect).toHaveBeenCalled();
      await user.click(screen.getByTitle('Delete connection'));
      expect(mocks.removeConnection).toHaveBeenCalledWith(currentId);
    });

    it('shows Disconnected, a placeholder for no brokers and no topic chip', () => {
      setConn({ status: 'disconnected', bootstrapBrokers: [], defaultTopic: '' });
      render(<KafkaClient />);
      expect(screen.getByLabelText('Kafka connection status: Disconnected')).toBeInTheDocument();
      expect(screen.getByText('no broker')).toBeInTheDocument();
    });

    it('disconnects from the header when connected', async () => {
      const user = userEvent.setup();
      render(<KafkaClient />);
      expect(screen.getByLabelText('Kafka connection status: Connected')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /Disconnect/ }));
      expect(mocks.disconnect).toHaveBeenCalled();
    });
  });

  describe('produce validation', () => {
    async function publish(): Promise<void> {
      await act(async () => {
        await producer().onPublish();
      });
    }
    function edit(fn: () => void): void {
      act(fn);
    }

    it('does nothing without a default topic', async () => {
      setConn({ defaultTopic: '' });
      render(<KafkaClient />);
      await publish();
      expect(mocks.produce).not.toHaveBeenCalled();
    });

    it('rejects invalid value and key schema ids when a registry is configured', async () => {
      setConn({ registry: { url: 'https://r' } });
      render(<KafkaClient />);
      edit(() => producer().setProduceSchemaId('abc'));
      await publish();
      expect(errorText()).toEqual(expect.stringContaining('Value'));
      edit(() => producer().setProduceSchemaId(''));
      edit(() => producer().setProduceKeySchemaId('-4'));
      await publish();
      expect(errorText()).toEqual(expect.stringContaining('Key'));
      expect(mocks.produce).not.toHaveBeenCalled();
    });

    it('ignores schema ids entirely when there is no registry', async () => {
      render(<KafkaClient />);
      edit(() => producer().setProduceSchemaId('abc'));
      edit(() => producer().setProduceValue('x'));
      await publish();
      expect(mocks.produce).toHaveBeenCalledTimes(1);
      expect(mocks.produce.mock.calls[0]![0]).not.toHaveProperty('valueSchemaId');
    });

    it('rejects invalid JSON values and keys, but skips the value check for tombstones', async () => {
      render(<KafkaClient />);
      edit(() => {
        producer().setProduceValueEncoding('json');
        producer().setProduceValue('{bad');
      });
      await publish();
      expect(errorText()).toEqual(expect.stringContaining('Value'));

      edit(() => producer().setProduceTombstone(true));
      edit(() => {
        producer().setProduceKeyEncoding('json');
        producer().setProduceKey('{bad');
      });
      await publish();
      expect(errorText()).toEqual(expect.stringContaining('Key'));
      expect(mocks.produce).not.toHaveBeenCalled();

      edit(() => producer().setProduceKey('{"ok":true}'));
      await publish();
      expect(mocks.produce).toHaveBeenCalledWith(
        expect.objectContaining({ value: null, key: '{"ok":true}', keyEncoding: 'utf8' })
      );
      expect(errorText()).toBeNull();
    });

    it('rejects a Base64 key combined with a schema id or subject, and a Base64 value with a schema id', async () => {
      setConn({ registry: { url: 'https://r' } });
      render(<KafkaClient />);
      edit(() => {
        producer().setProduceKey('a2V5');
        producer().setProduceKeyEncoding('base64');
        producer().setProduceKeySchemaId('5');
      });
      await publish();
      expect(errorText()).toBe('A Base64 key cannot also use a Schema Registry schema.');

      edit(() => {
        producer().setProduceKeySchemaId('');
        producer().setProduceKeySubject({ subject: 'k', version: 1 });
      });
      await publish();
      expect(errorText()).toBe('A Base64 key cannot also use a Schema Registry schema.');

      edit(() => {
        producer().setProduceKeyEncoding('utf8');
        producer().setProduceKeySubject(null);
        producer().setProduceValueEncoding('base64');
        producer().setProduceSchemaId('9');
      });
      await publish();
      expect(errorText()).toBe('A Base64 value cannot also use a Schema Registry schema.');
      expect(mocks.produce).not.toHaveBeenCalled();
    });

    it('sends Base64 key and value with the base64 encodings and no registry fields', async () => {
      render(<KafkaClient />);
      edit(() => {
        producer().setProduceKey('a2V5');
        producer().setProduceKeyEncoding('base64');
        producer().setProduceValue('dmFs');
        producer().setProduceValueEncoding('base64');
      });
      await publish();
      expect(mocks.produce).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'a2V5',
          keyEncoding: 'base64',
          value: 'dmFs',
          valueEncoding: 'base64',
        })
      );
    });

    it('rejects invalid headers and invalid partitions', async () => {
      render(<KafkaClient />);
      edit(() => producer().setProduceHeaders([{ id: 'h', key: '', value: 'v', enabled: true }]));
      await publish();
      expect(typeof errorText()).toBe('string');
      expect(mocks.produce).not.toHaveBeenCalled();

      edit(() => producer().setProduceHeaders([]));
      for (const bad of ['-1', '1.5', 'abc']) {
        edit(() => producer().setProducePartition(bad));
        await publish();
        expect(errorText()).toBe('Partition must be a non-negative safe integer.');
      }
      expect(mocks.produce).not.toHaveBeenCalled();
    });

    it('surfaces a send failure and keeps the composer payload', async () => {
      mocks.produce.mockResolvedValue({ ok: false, error: 'leader not available' });
      render(<KafkaClient />);
      edit(() => producer().setProduceValue('hello'));
      await publish();
      expect(errorText()).toBe('leader not available');
      expect(producer().produceValue).toBe('hello');
    });

    it('omits compression when none and includes it otherwise', async () => {
      const { unmount } = render(<KafkaClient />);
      await publish();
      expect(mocks.produce.mock.calls[0]![0]).not.toHaveProperty('compression');
      unmount();
      setConn({ compression: 'snappy' });
      render(<KafkaClient />);
      await publish();
      expect(mocks.produce.mock.calls[1]![0]).toMatchObject({ compression: 'snappy' });
    });
  });

  describe('consume', () => {
    it('maps committed/latest modes and from-offset/from-timestamp back from the stored consumer mode', () => {
      setConn({ consumer: { ...base.consumer, mode: 'manual' } });
      const { unmount } = render(<KafkaClient />);
      expect(consumer().consumeMode).toBe('from-offset');
      unmount();
      setConn({ consumer: { ...base.consumer, mode: 'timestamp' } });
      const second = render(<KafkaClient />);
      expect(consumer().consumeMode).toBe('from-timestamp');
      second.unmount();
      setConn({ consumer: { ...base.consumer, mode: 'latest' } });
      render(<KafkaClient />);
      expect(consumer().consumeMode).toBe('latest');
    });

    it('updates the consumer for plain mode changes', () => {
      render(<KafkaClient />);
      act(() => consumer().onConsumeModeChange('latest'));
      expect(mocks.updateConsumer).toHaveBeenCalledWith(currentId, {
        mode: 'latest',
        fromBeginning: false,
      });
      act(() => consumer().onConsumeModeChange('from-timestamp'));
      expect(mocks.updateConsumer).toHaveBeenLastCalledWith(currentId, {
        mode: 'timestamp',
        fromBeginning: false,
      });
    });

    it('flags an invalid manual offset and an invalid timestamp', () => {
      render(<KafkaClient />);
      act(() => {
        consumer().onConsumeModeChange('from-offset');
        consumer().setOffsetPartition('-1');
      });
      expect(consumer().offsetSpecInvalid).toBe(true);
      act(() => {
        consumer().setOffsetPartition('0');
        consumer().setOffsetValue('5');
      });
      expect(consumer().offsetSpecInvalid).toBe(false);
      act(() => {
        consumer().onConsumeModeChange('from-timestamp');
        consumer().setTimestampDraft('not a date');
      });
      expect(consumer().timestampInvalid).toBe(true);
    });

    it('does not subscribe without topics, and omits offsets/timestamp when those inputs are invalid', async () => {
      setConn({ consumer: { ...base.consumer, topics: [] } });
      const { unmount } = render(<KafkaClient />);
      await act(async () => {
        await consumer().onSubscribe();
      });
      expect(mocks.subscribe).not.toHaveBeenCalled();
      unmount();

      setConn();
      render(<KafkaClient />);
      act(() => {
        consumer().onConsumeModeChange('from-offset');
        consumer().setOffsetPartition('x');
      });
      await act(async () => {
        await consumer().onSubscribe();
      });
      expect(mocks.subscribe.mock.calls[0]![0]).not.toHaveProperty('offsets');
      expect(mocks.subscribe.mock.calls[0]![0]).toMatchObject({ mode: 'manual' });

      act(() => {
        consumer().onConsumeModeChange('from-timestamp');
        consumer().setTimestampDraft('garbage');
      });
      await act(async () => {
        await consumer().onSubscribe();
      });
      expect(mocks.subscribe.mock.calls[1]![0]).not.toHaveProperty('timestamp');
      expect(mocks.subscribe.mock.calls[1]![0]).toMatchObject({ mode: 'timestamp' });
    });

    it('keeps {{var}} topics and group in the stored form while sending resolved values', async () => {
      setConn({ consumer: { ...base.consumer, topics: ['{{missing}}'], groupId: '{{grp}}' } });
      render(<KafkaClient />);
      await act(async () => {
        await consumer().onSubscribe();
      });
      expect(mocks.subscribe.mock.calls[0]![0]).toMatchObject({
        stored: { groupId: '{{grp}}', topics: ['{{missing}}'] },
      });
    });

    it('ignores blank topic drafts and does not drop topics without a connection', () => {
      render(<KafkaClient />);
      act(() => {
        consumer().setTopicDraft('   ');
      });
      act(() => consumer().onAddTopic());
      expect(mocks.updateConsumer).not.toHaveBeenCalled();
      act(() => consumer().setTopicDraft('  new  '));
      act(() => consumer().onAddTopic());
      expect(mocks.updateConsumer).toHaveBeenCalledWith(currentId, { topics: ['orders', 'new'] });
    });

    it('leaves the consumer unpaused when pause/resume are rejected or the bridge is gone', async () => {
      mocks.pauseConsumer.mockResolvedValue({ success: false });
      mocks.resumeConsumer.mockResolvedValue({ success: false });
      render(<KafkaClient />);
      await act(async () => {
        consumer().onPause();
      });
      expect(consumer().consumerPaused).toBe(false);

      mocks.pauseConsumer.mockResolvedValue({ success: true });
      await act(async () => {
        consumer().onPause();
      });
      expect(consumer().consumerPaused).toBe(true);
      await act(async () => {
        consumer().onResume();
      });
      expect(consumer().consumerPaused).toBe(true);
      mocks.resumeConsumer.mockResolvedValue({ success: true });
      await act(async () => {
        consumer().onResume();
      });
      expect(consumer().consumerPaused).toBe(false);

      Object.defineProperty(window, 'electron', { configurable: true, value: undefined });
      act(() => {
        consumer().onPause();
        consumer().onResume();
      });
    });
  });
});
