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
    status: 'idle',
  },
  messages: [],
  createdAt: 0,
};

function ConsumerPanel({ offsetSpecInvalid = false }: { offsetSpecInvalid?: boolean }) {
  const [topicDraft, setTopicDraft] = useState('');
  const [consumeMode, setConsumeMode] = useState<ConsumeMode>('latest');
  const [offsetPartition, setOffsetPartition] = useState('0');
  const [offsetValue, setOffsetValue] = useState('0');
  const [timestampDraft, setTimestampDraft] = useState('');
  return (
    <Tabs value="consume">
      <KafkaConsumerPanel
        connection={connection}
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
      />
    </Tabs>
  );
}

describe('KafkaConsumerPanel', () => {
  it('keeps manual seek invalidity as a hard subscribe guard', async () => {
    const user = userEvent.setup();
    render(<ConsumerPanel offsetSpecInvalid />);

    await user.click(screen.getByRole('radio', { name: 'from-offset' }));

    expect(screen.getByRole('button', { name: 'Subscribe' })).toBeDisabled();
    expect(screen.getByText(/Seeks every subscribed topic/)).toBeInTheDocument();
  });
});
