import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Tabs } from '@/components/ui/tabs';
import type { KafkaConnection } from '../../store/useKafkaStore';
import { type ConsumeMode, KafkaConsumerPanel } from '../KafkaConsumerPanel';

const connection: KafkaConnection = {
  id: 'connection-1',
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
    groupId: 'restura-test',
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

function ConsumerPanel({
  offsetSpecInvalid = false,
  consumerPaused = false,
  connectionOverride,
  updateConsumer = vi.fn(),
  initialMode = 'latest',
}: {
  offsetSpecInvalid?: boolean;
  consumerPaused?: boolean;
  connectionOverride?: KafkaConnection;
  updateConsumer?: (id: string, patch: Partial<KafkaConnection['consumer']>) => void;
  initialMode?: ConsumeMode;
}) {
  const [topicDraft, setTopicDraft] = useState('');
  const [consumeMode, setConsumeMode] = useState<ConsumeMode>(initialMode);
  // Apply consumer patches locally so membership-dependent rendering updates.
  const [current, setCurrent] = useState(connectionOverride ?? connection);
  const [offsetPartition, setOffsetPartition] = useState('0');
  const [offsetValue, setOffsetValue] = useState('0');
  const [timestampDraft, setTimestampDraft] = useState('');
  return (
    <Tabs value="consume">
      <KafkaConsumerPanel
        connection={current}
        updateConsumer={(id, patch) => {
          updateConsumer(id, patch);
          setCurrent((prev) => ({ ...prev, consumer: { ...prev.consumer, ...patch } }));
        }}
        topicDraft={topicDraft}
        setTopicDraft={setTopicDraft}
        consumeMode={consumeMode}
        onConsumeModeChange={setConsumeMode}
        offsetPartition={offsetPartition}
        setOffsetPartition={setOffsetPartition}
        offsetValue={offsetValue}
        setOffsetValue={setOffsetValue}
        timestampDraft={timestampDraft}
        setTimestampDraft={setTimestampDraft}
        offsetSpecInvalid={offsetSpecInvalid}
        timestampInvalid={false}
        onAddTopic={vi.fn()}
        onRemoveTopic={vi.fn()}
        onSubscribe={vi.fn()}
        onUnsubscribe={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
        consumerPaused={consumerPaused}
      />
    </Tabs>
  );
}

describe('KafkaConsumerPanel', () => {
  it('keeps manual seek invalidity as a hard subscribe guard', async () => {
    const user = userEvent.setup();
    render(<ConsumerPanel offsetSpecInvalid />);

    await user.selectOptions(screen.getByLabelText('Consume start position'), 'from-offset');

    expect(screen.getByRole('button', { name: 'Subscribe' })).toBeDisabled();
    expect(screen.getByText(/Seeks every subscribed topic/)).toBeInTheDocument();
  });

  it('owns start position, runtime state, and progressively disclosed tuning', async () => {
    const user = userEvent.setup();
    render(<ConsumerPanel />);

    expect(screen.getByLabelText('Consume start position')).toHaveValue('latest');
    expect(screen.getByText('Subscription: Idle')).toBeVisible();
    expect(screen.getByText('Stream: Running')).toBeVisible();
    expect(screen.queryByLabelText('Session timeout (ms)')).not.toBeVisible();

    await user.click(screen.getByText('Performance tuning'));

    expect(screen.getByLabelText('Session timeout (ms)')).toHaveAttribute(
      'placeholder',
      'Client default'
    );
    expect(screen.getByText(/Blank values use the native Kafka client defaults/)).toBeVisible();
  });

  it('shows one resume action and no duplicate raw subscription status while paused', () => {
    render(
      <ConsumerPanel
        consumerPaused
        connectionOverride={{
          ...connection,
          consumer: { ...connection.consumer, status: 'subscribed' },
        }}
      />
    );

    expect(screen.getByRole('button', { name: 'Resume consumer' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Pause consumer' })).not.toBeInTheDocument();
    expect(screen.getByText('Subscription: Subscribed')).toBeVisible();
    expect(screen.getByText('Stream: Paused')).toBeVisible();
    expect(screen.queryByText(/^subscribed$/)).not.toBeInTheDocument();
  });

  describe('browse mode', () => {
    const browseConnection: KafkaConnection = {
      ...connection,
      consumer: { ...connection.consumer, membership: 'browse', mode: 'last-n', lastN: 50 },
    };
    const startOptions = () =>
      Array.from(
        (screen.getByLabelText('Consume start position') as HTMLSelectElement).options,
        (option) => option.value
      );

    it('shows a read-only badge and hides every group and commit control', async () => {
      const user = userEvent.setup();
      render(<ConsumerPanel connectionOverride={browseConnection} initialMode="last-n" />);

      expect(screen.getByRole('radio', { name: 'Browse' })).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByText('Read-only — no group')).toBeVisible();
      expect(screen.queryByLabelText('Consumer group ID')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Commit policy')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Group protocol')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Isolation')).toBeVisible();
      expect(startOptions()).not.toContain('committed');
      expect(startOptions()).toContain('last-n');
      expect(screen.getByLabelText('Records per partition')).toHaveValue(50);
      expect(screen.getByLabelText('Stop after (records)')).toHaveValue(null);

      await user.click(screen.getByText('Performance tuning'));
      expect(screen.queryByLabelText('Static member ID')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Session timeout (ms)')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Auto-commit interval (ms)')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Maximum wait (ms)')).toBeVisible();
    });

    it('edits last-N and the stop-after limit, ignoring non-positive input', async () => {
      const user = userEvent.setup();
      const updateConsumer = vi.fn();
      render(
        <ConsumerPanel
          connectionOverride={browseConnection}
          initialMode="last-n"
          updateConsumer={updateConsumer}
        />
      );
      await user.type(screen.getByLabelText('Stop after (records)'), '7');
      expect(updateConsumer).toHaveBeenLastCalledWith('connection-1', { maxMessages: 7 });
      const lastN = screen.getByLabelText('Records per partition');
      await user.clear(lastN);
      expect(updateConsumer).toHaveBeenLastCalledWith('connection-1', { lastN: undefined });
      // Cleared stays cleared (the default is only a placeholder), so Backspace
      // then typing gives the typed value rather than "502".
      expect(lastN).toHaveValue(null);
      expect(lastN).toHaveAttribute('placeholder', '50');
      await user.type(lastN, '2');
      expect(updateConsumer).toHaveBeenLastCalledWith('connection-1', { lastN: 2 });
      expect(lastN).toHaveValue(2);
    });

    it('switching to group mode swaps a browse-only start for committed', async () => {
      const user = userEvent.setup();
      const updateConsumer = vi.fn();
      render(
        <ConsumerPanel
          connectionOverride={browseConnection}
          initialMode="last-n"
          updateConsumer={updateConsumer}
        />
      );
      await user.click(screen.getByRole('radio', { name: 'Consumer group' }));
      expect(updateConsumer).toHaveBeenCalledWith('connection-1', { membership: 'group' });
      expect(screen.getByLabelText('Consume start position')).toHaveValue('committed');
    });

    it('switching to browse swaps committed for last-N; group mode offers no last-N', async () => {
      const user = userEvent.setup();
      const updateConsumer = vi.fn();
      render(<ConsumerPanel initialMode="committed" updateConsumer={updateConsumer} />);
      expect(startOptions()).not.toContain('last-n');
      expect(screen.getByLabelText('Consumer group ID')).toHaveValue('restura-test');

      await user.click(screen.getByRole('radio', { name: 'Browse' }));
      expect(updateConsumer).toHaveBeenCalledWith('connection-1', { membership: 'browse' });
      expect(screen.getByLabelText('Consume start position')).toHaveValue('last-n');
    });

    it('locks the mode toggle while subscribed', () => {
      render(
        <ConsumerPanel
          connectionOverride={{
            ...browseConnection,
            consumer: { ...browseConnection.consumer, status: 'subscribed' },
          }}
          initialMode="last-n"
        />
      );
      expect(screen.getByRole('radio', { name: 'Consumer group' })).toBeDisabled();
    });
  });
});
