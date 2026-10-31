import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Tabs } from '@/components/ui/tabs';
import type { KafkaConnection, KafkaMessage } from '../../store/useKafkaStore';
import { useKafkaStore } from '../../store/useKafkaStore';
import { KafkaMessagesPanel } from '../KafkaMessagesPanel';

const commitMessage = vi.fn();

function makeConnection(
  messages: KafkaMessage[],
  consumer: Partial<KafkaConnection['consumer']> = {},
  id = 'conn-1'
): KafkaConnection {
  return {
    id,
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
      groupId: 'grp',
      topics: ['orders'],
      fromBeginning: false,
      mode: 'committed',
      fallbackMode: 'latest',
      commitPolicy: 'manual',
      isolation: 'read-committed',
      groupProtocol: 'classic',
      status: 'subscribed',
      ...consumer,
    },
    messages,
    createdAt: 0,
  };
}

function install(connection: KafkaConnection): void {
  useKafkaStore.setState({
    connections: { [connection.id]: connection },
    messageFilter: 'all',
    searchQuery: '',
  });
}

function Panel({ connection }: { connection: KafkaConnection }) {
  const [paused, setPaused] = useState(false);
  return (
    <Tabs value="messages">
      <KafkaMessagesPanel connection={connection} paused={paused} onPausedChange={setPaused} />
    </Tabs>
  );
}

const received = (over: Partial<KafkaMessage>): KafkaMessage => ({
  id: 'r',
  direction: 'received',
  topic: 'orders',
  value: 'v',
  timestamp: Date.now(),
  ...over,
});

describe('KafkaMessagesPanel branches', () => {
  beforeEach(() => {
    commitMessage.mockReset();
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: { kafka: { commitMessage } },
    });
  });
  afterEach(() => {
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it('shows empty-state placeholders with no messages, partitions, lag or group', () => {
    const conn = makeConnection([], { groupId: '' });
    install(conn);
    render(<Panel connection={conn} />);
    expect(screen.getByText('No messages yet.')).toBeInTheDocument();
    expect(screen.getByText('Select a message to inspect.')).toBeInTheDocument();
    expect(screen.getByText('0.0')).toBeInTheDocument();
    // Partitions, Consumer ID and Lag all fall back to an em dash.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
  });

  it('summarises partitions, total lag and recent throughput', () => {
    const conn = makeConnection(
      [
        received({ id: 'a', partition: 1, offset: '5', key: 'k1', value: '{"a":1}' }),
        received({ id: 'b', partition: 0, offset: '6' }),
        received({ id: 'c', partition: 1, offset: '7' }),
        received({ id: 'old', partition: 2, timestamp: Date.now() - 60_000 }),
        { ...received({ id: 's' }), direction: 'sent' },
      ],
      {
        lag: [
          { topic: 'orders', offsets: ['3', '4'] },
          { topic: 'other', offsets: ['10'] },
        ],
      }
    );
    install(conn);
    render(<Panel connection={conn} />);
    expect(screen.getByText('17')).toBeInTheDocument();
    expect(screen.getAllByText('P0').length).toBeGreaterThan(0);
    expect(screen.getAllByText('P2').length).toBeGreaterThan(0);
    // 3 received within the last 5 seconds => 0.6 msg/sec
    expect(screen.getByText('0.6')).toBeInTheDocument();
  });

  it('renders rows without partition, offset or key as placeholders and shows record errors', () => {
    const conn = makeConnection([
      received({ id: 'e', error: 'decode failed', value: 'ignored' }),
      received({ id: 't', tombstone: true, partition: 3, offset: '9', key: 'dead' }),
    ]);
    install(conn);
    render(<Panel connection={conn} />);
    expect(screen.getByText('decode failed')).toHaveClass('text-red-400');
    expect(screen.getAllByText('<tombstone>').length).toBeGreaterThan(0);
    expect(
      screen.getByRole('button', {
        name: 'Kafka record in orders, partition unknown, offset unknown',
      })
    ).toBeInTheDocument();
  });

  it('inspects a keyed Base64 record with headers, raw headers and a schema, and an error row', async () => {
    const user = userEvent.setup();
    const conn = makeConnection([
      received({
        id: 'x',
        partition: 2,
        offset: '11',
        key: 'a2V5',
        keyEncoding: 'base64',
        value: 'dmFs',
        valueEncoding: 'base64',
        headers: { trace: 'abc' },
        binaryHeaders: [{ key: 'bin', value: 'AAE=' }] as never,
        error: 'boom',
      }),
    ]);
    install(conn);
    render(<Panel connection={conn} />);
    await user.click(screen.getByRole('button', { name: /Kafka record in orders, partition 2/ }));
    expect(screen.getByText(/Key · Base64/)).toBeInTheDocument();
    expect(screen.getByText(/Value · Base64/)).toBeInTheDocument();
    expect(screen.getByText('trace')).toBeInTheDocument();
    expect(screen.getByText('abc')).toBeInTheDocument();
    expect(screen.getByText(/Raw headers/)).toBeInTheDocument();
    expect(screen.getByText('Error')).toBeInTheDocument();
  });

  it('shows pretty-printed JSON, "No headers", and hides topic/key sections when absent', async () => {
    const user = userEvent.setup();
    const conn = makeConnection([received({ id: 'j', topic: '', value: '{"a":1}' })]);
    install(conn);
    render(<Panel connection={conn} />);
    await user.click(screen.getByRole('button', { name: /Kafka record in/ }));
    expect(screen.getByText('No headers')).toBeInTheDocument();
    expect(screen.queryByText('Topic')).not.toBeInTheDocument();
    expect(screen.queryByText('Raw headers · Base64')).not.toBeInTheDocument();
    expect(screen.getByText(/"a": 1/)).toBeInTheDocument();
  });

  it('selects rows via Enter and Space, including activity rows', async () => {
    const user = userEvent.setup();
    const conn = makeConnection([
      { id: 'sys', direction: 'system', topic: '', value: 'Connected', timestamp: 1 },
      received({ id: 'rec', partition: 0, offset: '1', value: 'hello' }),
    ]);
    install(conn);
    render(<Panel connection={conn} />);

    screen.getByRole('button', { name: 'Activity: Connected' }).focus();
    await user.keyboard('{Enter}');
    expect(screen.queryByText('Select a message to inspect.')).not.toBeInTheDocument();

    screen.getByRole('button', { name: /Kafka record in orders/ }).focus();
    await user.keyboard(' ');
    expect(screen.getAllByText('hello').length).toBeGreaterThan(1);

    screen.getByRole('button', { name: 'Activity: Connected' }).focus();
    await user.keyboard('a');
    await user.keyboard(' ');
    expect(screen.queryByText('Select a message to inspect.')).not.toBeInTheDocument();
  });

  it('commits a record offset once, and keeps the button available when the commit fails', async () => {
    const user = userEvent.setup();
    const conn = makeConnection([
      received({ id: 'c', partition: 0, offset: '1', commitToken: 'tok' }),
    ]);
    install(conn);
    render(<Panel connection={conn} />);
    await user.click(screen.getByRole('button', { name: /Kafka record in orders/ }));

    commitMessage.mockResolvedValueOnce({ success: false });
    await user.click(screen.getByRole('button', { name: 'Commit this message' }));
    await waitFor(() => expect(commitMessage).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Commit this message' })).toBeEnabled();

    commitMessage.mockResolvedValueOnce({ success: true });
    await user.click(screen.getByRole('button', { name: 'Commit this message' }));
    const done = await screen.findByRole('button', { name: 'Offset committed' });
    expect(done).toBeDisabled();
    expect(commitMessage).toHaveBeenLastCalledWith({ connectionId: 'conn-1', commitToken: 'tok' });
  });

  it('filters by direction and search text, and clears the log', async () => {
    const user = userEvent.setup();
    const conn = makeConnection([
      received({ id: '1', value: 'alpha', key: 'KEYA' }),
      received({ id: '2', value: 'beta', topic: 'payments' }),
      { id: '3', direction: 'sent', topic: 'orders', value: 'gamma', timestamp: 3 },
    ]);
    install(conn);
    const { rerender } = render(<Panel connection={conn} />);

    await user.type(screen.getByPlaceholderText('Search topic, key, value'), 'keya');
    rerender(<Panel connection={useKafkaStore.getState().connections['conn-1']!} />);
    expect(screen.getAllByRole('button', { name: /Kafka record/ })).toHaveLength(1);

    await user.clear(screen.getByPlaceholderText('Search topic, key, value'));
    await user.type(screen.getByPlaceholderText('Search topic, key, value'), 'payments');
    rerender(<Panel connection={useKafkaStore.getState().connections['conn-1']!} />);
    expect(screen.getAllByRole('button', { name: /Kafka record/ })).toHaveLength(1);

    useKafkaStore.getState().setSearchQuery('');
    useKafkaStore.getState().setMessageFilter('sent');
    rerender(<Panel connection={useKafkaStore.getState().connections['conn-1']!} />);
    expect(screen.getAllByRole('button', { name: /Kafka record/ })).toHaveLength(1);

    await user.click(screen.getByTitle('Clear messages'));
    rerender(<Panel connection={useKafkaStore.getState().connections['conn-1']!} />);
    expect(screen.getByText('No messages yet.')).toBeInTheDocument();
  });

  it('freezes the visible list while paused and resumes live on toggle', async () => {
    const user = userEvent.setup();
    const conn = makeConnection([received({ id: '1', value: 'first' })]);
    install(conn);
    const { rerender } = render(<Panel connection={conn} />);
    await user.click(screen.getByRole('button', { name: 'Freeze message view' }));
    expect(screen.getByText('Frozen')).toBeInTheDocument();

    const grown = { ...conn, messages: [...conn.messages, received({ id: '2', value: 'second' })] };
    useKafkaStore.setState({ connections: { [conn.id]: grown } });
    rerender(<Panel connection={grown} />);
    expect(screen.getAllByRole('button', { name: /Kafka record/ })).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Resume live message view' }));
    expect(screen.getAllByRole('button', { name: /Kafka record/ })).toHaveLength(2);
    expect(within(document.body).queryByText('Frozen')).not.toBeInTheDocument();
  });

  it('clears the selection when the connection changes', async () => {
    const user = userEvent.setup();
    const one = makeConnection([received({ id: '1', value: 'one' })], {}, 'conn-1');
    install(one);
    const { rerender } = render(<Panel connection={one} />);
    await user.click(screen.getByRole('button', { name: /Kafka record/ }));
    expect(screen.queryByText('Select a message to inspect.')).not.toBeInTheDocument();
    const two = makeConnection([received({ id: '1', value: 'one' })], {}, 'conn-2');
    useKafkaStore.setState({ connections: { 'conn-2': two } });
    rerender(<Panel connection={two} />);
    expect(screen.getByText('Select a message to inspect.')).toBeInTheDocument();
  });
});
