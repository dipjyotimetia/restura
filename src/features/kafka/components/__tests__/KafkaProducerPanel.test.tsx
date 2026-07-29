import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Tabs } from '@/components/ui/tabs';
import type { KafkaConnection } from '../../store/useKafkaStore';
import { KafkaProducerPanel } from '../KafkaProducerPanel';

const api = vi.hoisted(() => ({
  produceBatch: vi.fn(),
  openProducerStream: vi.fn(),
  writeProducerStream: vi.fn(),
  closeProducerStream: vi.fn(),
  beginTransaction: vi.fn(),
  endTransaction: vi.fn(),
}));

vi.mock('@/lib/shared/platform', () => ({
  getElectronAPI: () => ({ kafka: api }),
}));

vi.mock('@/components/shared/CodeEditor', () => ({
  default: ({
    value,
    onChange,
    language,
    ariaLabel,
  }: {
    value: string;
    onChange?: (value: string) => void;
    language?: string;
    ariaLabel?: string;
  }) => (
    <textarea
      aria-label={ariaLabel}
      data-editor="monaco"
      data-language={language}
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    />
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
  acks: 1,
  compression: 'none',
  idempotent: true,
  transactionalId: 'restura-test-transaction',
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

describe('KafkaProducerPanel', () => {
  const renderPanel = (
    overrides: {
      connection?: KafkaConnection;
      produceValueEncoding?: 'utf8' | 'base64' | 'json';
      produceSchemaId?: string;
      produceKeySchemaId?: string;
      produceError?: string | null;
      produceTombstone?: boolean;
    } = {}
  ) => {
    const noop = vi.fn();
    return render(
      <Tabs value="produce">
        <KafkaProducerPanel
          connection={overrides.connection ?? connection}
          updateConnection={noop}
          produceKey=""
          setProduceKey={noop}
          produceKeyEncoding="utf8"
          setProduceKeyEncoding={noop}
          produceValue=""
          setProduceValue={noop}
          produceValueEncoding={overrides.produceValueEncoding ?? 'utf8'}
          setProduceValueEncoding={noop}
          produceHeaders={[]}
          setProduceHeaders={noop}
          producePartition=""
          setProducePartition={noop}
          produceSchemaId={overrides.produceSchemaId ?? ''}
          setProduceSchemaId={noop}
          produceKeySchemaId={overrides.produceKeySchemaId ?? ''}
          setProduceKeySchemaId={noop}
          produceError={overrides.produceError ?? null}
          produceTombstone={overrides.produceTombstone ?? false}
          setProduceTombstone={noop}
          onPublish={noop}
        />
      </Tabs>
    );
  };

  it('serializes producer session operations while a native request is in flight', async () => {
    let finishBatch: ((result: { success: boolean }) => void) | undefined;
    api.produceBatch.mockReturnValueOnce(
      new Promise<{ success: boolean }>((resolve) => {
        finishBatch = resolve;
      })
    );
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('tab', { name: 'Batch' }));
    await user.click(screen.getByRole('button', { name: 'Publish batch' }));

    expect(screen.getByRole('button', { name: 'Publish batch' })).toBeDisabled();
    await user.click(screen.getByRole('tab', { name: 'Transaction' }));
    expect(screen.getByRole('button', { name: 'Begin transaction' })).toBeDisabled();
    await user.click(screen.getByRole('tab', { name: 'Stream' }));
    expect(screen.getByRole('button', { name: 'Open stream' })).toBeDisabled();

    finishBatch?.({ success: true });
    await user.click(screen.getByRole('tab', { name: 'Transaction' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Begin transaction' })).toBeEnabled()
    );
  });

  it('drives native stream and transaction sessions in sequence', async () => {
    api.openProducerStream.mockResolvedValueOnce({ success: true });
    api.writeProducerStream.mockResolvedValueOnce({ success: true });
    api.closeProducerStream.mockResolvedValueOnce({ success: true });
    api.beginTransaction.mockResolvedValue({ success: true, transactionId: 'txn-1' });
    api.endTransaction.mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('tab', { name: 'Stream' }));
    fireEvent.change(screen.getByLabelText('Kafka typed record batch'), {
      target: { value: '[{"topic":"orders","value":{"encoding":"utf8","data":"one"}}]' },
    });
    await user.click(screen.getByRole('button', { name: 'Open stream' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close stream' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Write batch to stream' }));
    await waitFor(() => expect(api.writeProducerStream).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: 'Close stream' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open stream' })).toBeEnabled());

    await user.click(screen.getByRole('tab', { name: 'Transaction' }));
    await user.click(screen.getByRole('button', { name: 'Begin transaction' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Send batch in transaction' }));
    await waitFor(() => expect(api.produceBatch).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: 'Commit' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Begin transaction' })).toBeEnabled()
    );
    await user.click(screen.getByRole('button', { name: 'Begin transaction' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Abort' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Abort' }));

    expect(api.openProducerStream).toHaveBeenCalled();
    expect(api.closeProducerStream).toHaveBeenCalled();
    expect(api.endTransaction).toHaveBeenCalledWith({
      connectionId: connection.id,
      action: 'abort',
    });
  });

  it('renders encoding, registry, tombstone, idempotence, and error guidance', () => {
    renderPanel({
      connection: {
        ...connection,
        registry: { url: 'https://registry.example.test' },
      },
      produceValueEncoding: 'base64',
      produceSchemaId: '1',
      produceKeySchemaId: '2',
      produceError: 'Malformed payload',
      produceTombstone: true,
    });

    expect(screen.getByText('Locked to -1 by idempotent mode.')).toBeVisible();
    expect(screen.getByText(/Sent as exact decoded bytes/)).toBeVisible();
    expect(screen.getByText(/Value is parsed as JSON/)).toBeVisible();
    expect(screen.getByText(/Key is parsed as JSON/)).toBeVisible();
    expect(screen.getByText('Malformed payload')).toBeVisible();
    expect(screen.getByLabelText('Kafka message value')).toBeDisabled();
    expect(screen.getByText(/Kafka receives a null value/)).toBeVisible();
  });

  it('presents each producer workflow as an explicit mode', async () => {
    const user = userEvent.setup();
    renderPanel();

    expect(screen.getByRole('tab', { name: 'Single record' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await user.click(screen.getByRole('tab', { name: 'Batch' }));
    expect(screen.getByRole('button', { name: 'Publish batch' })).toBeVisible();
    expect(await screen.findByLabelText('Kafka typed record batch')).toHaveAttribute(
      'data-editor',
      'monaco'
    );
    expect(screen.getByLabelText('Kafka typed record batch')).toHaveAttribute(
      'data-language',
      'json'
    );
    await user.click(screen.getByRole('tab', { name: 'Stream' }));
    expect(screen.getByRole('button', { name: 'Open stream' })).toBeVisible();
    await user.click(screen.getByRole('tab', { name: 'Transaction' }));
    expect(screen.getByRole('button', { name: 'Begin transaction' })).toBeVisible();
  });

  it('uses Monaco when a single-record value is structured JSON', async () => {
    renderPanel({ produceValueEncoding: 'json' });

    expect(await screen.findByLabelText('Kafka message value')).toHaveAttribute(
      'data-editor',
      'monaco'
    );
    expect(screen.getByLabelText('Kafka message value')).toHaveAttribute('data-language', 'json');
  });
});
