import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KafkaConnection, KafkaMessage } from '../../store/useKafkaStore';
import { KafkaPartitionControls } from '../KafkaPartitionControls';

function makeConnection(
  overrides: Partial<KafkaConnection['consumer']> = {},
  messages: KafkaMessage[] = []
): KafkaConnection {
  return {
    id: 'conn-1',
    name: 'Kafka connection',
    clientId: 'restura-test',
    bootstrapBrokers: ['localhost:9092'],
    auth: { securityProtocol: 'PLAINTEXT' },
    status: 'connected',
    defaultTopic: '',
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
      status: 'subscribed',
      // Partition 1 is assigned to another member (-1).
      lag: [{ topic: 'orders', offsets: ['3', '-1', '0'] }],
      ...overrides,
    },
    messages,
    createdAt: 0,
  };
}

const received = (partition: number, offset: string): KafkaMessage => ({
  id: `${partition}-${offset}`,
  direction: 'received',
  topic: 'orders',
  partition,
  offset,
  value: 'v',
  timestamp: 1,
});

function installKafkaApi() {
  const kafka = {
    pausePartitions: vi.fn(async ({ partitions }: { partitions: unknown[] }) => ({
      success: true,
      pausedPartitions: partitions,
    })),
    resumePartitions: vi.fn(async () => ({ success: true, pausedPartitions: [] })),
    seekConsumer: vi.fn(async () => ({ success: true, offset: '42' })),
  };
  Object.defineProperty(window, 'electron', {
    value: { isElectron: true, kafka },
    configurable: true,
  });
  return kafka;
}

describe('KafkaPartitionControls', () => {
  let kafka: ReturnType<typeof installKafkaApi>;
  beforeEach(() => {
    kafka = installKafkaApi();
  });
  afterEach(() => {
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it('renders nothing until the consumer is subscribed', () => {
    const { container } = render(
      <KafkaPartitionControls connection={makeConnection({ status: 'idle' })} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('lists assigned partitions from lag plus partitions that delivered records', () => {
    render(
      <KafkaPartitionControls
        connection={makeConnection({}, [received(0, '9'), received(0, '11'), received(3, '5')])}
      />
    );
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[1]!.textContent)).toEqual([
      'P0',
      'P2',
      'P3',
    ]);
    expect(within(rows[0]!).getAllByRole('cell')[2]).toHaveTextContent('3');
    expect(within(rows[0]!).getAllByRole('cell')[3]).toHaveTextContent('11');
    expect(within(rows[2]!).getAllByRole('cell')[2]).toHaveTextContent('—');
  });

  it('explains the empty state before any assignment', () => {
    render(<KafkaPartitionControls connection={makeConnection({ lag: undefined })} />);
    expect(screen.getByText(/Partitions appear once the consumer is assigned/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Seek' })).not.toBeInTheDocument();
  });

  it('pauses and resumes a single partition through IPC', async () => {
    const user = userEvent.setup();
    render(<KafkaPartitionControls connection={makeConnection()} />);

    await user.click(screen.getByRole('button', { name: 'Pause orders partition 2' }));
    expect(kafka.pausePartitions).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      partitions: [{ topic: 'orders', partition: 2 }],
    });
    expect(screen.getByRole('status')).toHaveTextContent('Paused orders partition 2');
    expect(screen.getByRole('button', { name: 'Pause orders partition 0' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Resume orders partition 2' }));
    expect(kafka.resumePartitions).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      partitions: [{ topic: 'orders', partition: 2 }],
    });
    expect(screen.getByRole('button', { name: 'Pause orders partition 2' })).toBeInTheDocument();
  });

  it('surfaces rejected or failed partition calls as an error status', async () => {
    const user = userEvent.setup();
    kafka.pausePartitions.mockRejectedValueOnce(new Error('Rate limit exceeded'));
    render(<KafkaPartitionControls connection={makeConnection()} />);
    await user.click(screen.getByRole('button', { name: 'Pause orders partition 0' }));
    expect(screen.getByRole('status')).toHaveTextContent('Rate limit exceeded');
    expect(screen.getByRole('button', { name: 'Pause orders partition 0' })).toBeInTheDocument();

    kafka.resumePartitions.mockResolvedValueOnce({ success: false, error: 'broker down' } as never);
    kafka.pausePartitions.mockResolvedValueOnce({
      success: true,
      pausedPartitions: [{ topic: 'orders', partition: 0 }],
    });
    await user.click(screen.getByRole('button', { name: 'Pause orders partition 0' }));
    await user.click(screen.getByRole('button', { name: 'Resume orders partition 0' }));
    expect(screen.getByRole('status')).toHaveTextContent('broker down');
  });

  it('seeks the selected partition by offset', async () => {
    const user = userEvent.setup();
    render(<KafkaPartitionControls connection={makeConnection()} />);
    const seek = screen.getByRole('button', { name: 'Seek' });
    expect(seek).toBeDisabled();

    await user.selectOptions(screen.getByLabelText('Seek partition'), 'orders:2');
    await user.type(screen.getByLabelText('Offset'), 'abc');
    expect(seek).toBeDisabled();
    await user.clear(screen.getByLabelText('Offset'));
    await user.type(screen.getByLabelText('Offset'), '40');
    await user.click(seek);

    expect(kafka.seekConsumer).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      topic: 'orders',
      partition: 2,
      target: { kind: 'offset', offset: '40' },
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'orders partition 2 now reads from offset 42'
    );
  });

  it('seeks by timestamp and reports the resume point of a paused partition', async () => {
    const user = userEvent.setup();
    render(<KafkaPartitionControls connection={makeConnection()} />);
    await user.click(screen.getByRole('button', { name: 'Pause orders partition 0' }));

    await user.selectOptions(screen.getByLabelText('To'), 'timestamp');
    await user.type(screen.getByLabelText('Time'), '2026-01-02T03:04');
    await user.click(screen.getByRole('button', { name: 'Seek' }));

    expect(kafka.seekConsumer).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      topic: 'orders',
      partition: 0,
      target: { kind: 'timestamp', timestamp: String(new Date('2026-01-02T03:04').getTime()) },
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'orders partition 0 will resume from offset 42'
    );

    kafka.seekConsumer.mockResolvedValueOnce({ success: false, error: 'boom' } as never);
    await user.click(screen.getByRole('button', { name: 'Seek' }));
    expect(screen.getByRole('status')).toHaveTextContent('boom');
  });

  it('forgets paused partitions when the subscription ends', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<KafkaPartitionControls connection={makeConnection()} />);
    await user.click(screen.getByRole('button', { name: 'Pause orders partition 0' }));
    rerender(<KafkaPartitionControls connection={makeConnection({ status: 'idle' })} />);
    rerender(<KafkaPartitionControls connection={makeConnection()} />);
    expect(screen.getByRole('button', { name: 'Pause orders partition 0' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('reports a missing Electron bridge', async () => {
    delete (window as unknown as { electron?: unknown }).electron;
    const user = userEvent.setup();
    render(<KafkaPartitionControls connection={makeConnection()} />);
    await user.click(screen.getByRole('button', { name: 'Pause orders partition 0' }));
    expect(screen.getByRole('status')).toHaveTextContent('Electron API unavailable.');
  });
});
