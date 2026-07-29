import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Tabs } from '@/components/ui/tabs';
import type { KafkaConnection } from '../../store/useKafkaStore';
import { KafkaConsumerPanel, type ConsumeMode } from '../KafkaConsumerPanel';

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
}: {
  offsetSpecInvalid?: boolean;
  consumerPaused?: boolean;
  connectionOverride?: KafkaConnection;
}) {
  const [topicDraft, setTopicDraft] = useState('');
  const [consumeMode, setConsumeMode] = useState<ConsumeMode>('latest');
  const [offsetPartition, setOffsetPartition] = useState('0');
  const [offsetValue, setOffsetValue] = useState('0');
  const [timestampDraft, setTimestampDraft] = useState('');
  return (
    <Tabs value="consume">
      <KafkaConsumerPanel
        connection={connectionOverride ?? connection}
        updateConsumer={vi.fn()}
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
    expect(
      screen.getByText(/Blank values use the native Kafka client defaults/)
    ).toBeVisible();
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
});
