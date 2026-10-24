import { describe, expect, it } from 'vitest';
import { IPC } from '../../shared/channels';
import { KafkaPartitionControlSchema, KafkaSeekConsumerSchema } from '../ipc/ipc-validators';

describe('Kafka live-consumer control validators (#942)', () => {
  it('registers distinct channel names for partition pause/resume and seek', () => {
    expect(IPC.kafka.pausePartitions).toBe('kafka:consumer-pause-partitions');
    expect(IPC.kafka.resumePartitions).toBe('kafka:consumer-resume-partitions');
    expect(IPC.kafka.seekConsumer).toBe('kafka:consumer-seek');
  });

  describe('KafkaPartitionControlSchema', () => {
    const valid = { connectionId: 'c', partitions: [{ topic: 'orders.v1', partition: 0 }] };

    it('accepts a list of topic partitions', () => {
      expect(KafkaPartitionControlSchema.safeParse(valid).success).toBe(true);
    });

    it.each([
      ['an empty list', { ...valid, partitions: [] }],
      [
        'more than 1000 partitions',
        {
          ...valid,
          partitions: Array.from({ length: 1001 }, (_, i) => ({ topic: 't', partition: i })),
        },
      ],
      ['a negative partition', { ...valid, partitions: [{ topic: 'orders', partition: -1 }] }],
      ['a fractional partition', { ...valid, partitions: [{ topic: 'orders', partition: 1.5 }] }],
      ['an illegal topic name', { ...valid, partitions: [{ topic: 'bad topic', partition: 0 }] }],
      ['a topic with a colon', { ...valid, partitions: [{ topic: 'a:1', partition: 0 }] }],
      ['a missing connection id', { partitions: valid.partitions }],
    ])('rejects %s', (_label, payload) => {
      expect(KafkaPartitionControlSchema.safeParse(payload).success).toBe(false);
    });
  });

  describe('KafkaSeekConsumerSchema', () => {
    const base = { connectionId: 'c', topic: 'orders', partition: 2 };

    it('accepts offset and timestamp targets', () => {
      expect(
        KafkaSeekConsumerSchema.safeParse({ ...base, target: { kind: 'offset', offset: '0' } })
          .success
      ).toBe(true);
      expect(
        KafkaSeekConsumerSchema.safeParse({
          ...base,
          target: { kind: 'offset', offset: '9223372036854775807' },
        }).success
      ).toBe(true);
      expect(
        KafkaSeekConsumerSchema.safeParse({
          ...base,
          target: { kind: 'timestamp', timestamp: '1700000000000' },
        }).success
      ).toBe(true);
    });

    it.each([
      ['a negative offset', { kind: 'offset', offset: '-1' }],
      ['a non-numeric offset', { kind: 'offset', offset: 'latest' }],
      ['an offset beyond int64', { kind: 'offset', offset: '9223372036854775808' }],
      ['an empty timestamp', { kind: 'timestamp', timestamp: '' }],
      ['a numeric (non-string) timestamp', { kind: 'timestamp', timestamp: 1_700_000_000_000 }],
      ['an unknown target kind', { kind: 'latest' }],
      ['an offset under the timestamp kind', { kind: 'timestamp', offset: '5' }],
    ])('rejects %s', (_label, target) => {
      expect(KafkaSeekConsumerSchema.safeParse({ ...base, target }).success).toBe(false);
    });

    it('rejects a missing target or partition', () => {
      expect(KafkaSeekConsumerSchema.safeParse(base).success).toBe(false);
      expect(
        KafkaSeekConsumerSchema.safeParse({
          connectionId: 'c',
          topic: 'orders',
          target: { kind: 'offset', offset: '1' },
        }).success
      ).toBe(false);
    });
  });
});
