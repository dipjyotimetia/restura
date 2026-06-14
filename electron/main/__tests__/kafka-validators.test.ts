import { describe, expect, it } from 'vitest';
import {
  KafkaConnectSchema,
  KafkaCreateTopicSchema,
  KafkaDeleteTopicSchema,
  KafkaDisconnectSchema,
  KafkaListGroupsSchema,
  KafkaListTopicsSchema,
  KafkaProduceSchema,
  KafkaSubscribeSchema,
  KafkaUnsubscribeSchema,
} from '../ipc/ipc-validators';

describe('Kafka IPC validators', () => {
  describe('KafkaConnectSchema', () => {
    it('accepts a minimal PLAINTEXT config', () => {
      const result = KafkaConnectSchema.safeParse({
        connectionId: 'abc-123',
        clientId: 'restura-test',
        bootstrapBrokers: ['localhost:9092'],
        auth: { securityProtocol: 'PLAINTEXT' },
      });
      expect(result.success).toBe(true);
    });

    it('accepts an optional Schema Registry config with auth', () => {
      const result = KafkaConnectSchema.safeParse({
        connectionId: 'abc',
        clientId: 'r',
        bootstrapBrokers: ['localhost:9092'],
        auth: { securityProtocol: 'PLAINTEXT' },
        registry: {
          url: 'https://schema-registry:8081',
          auth: { username: 'u', password: 'p', token: 't' },
        },
      });
      expect(result.success).toBe(true);
    });

    it('rejects a Schema Registry with a non-URL', () => {
      const result = KafkaConnectSchema.safeParse({
        connectionId: 'abc',
        clientId: 'r',
        bootstrapBrokers: ['localhost:9092'],
        auth: { securityProtocol: 'PLAINTEXT' },
        registry: { url: 'not-a-url' },
      });
      expect(result.success).toBe(false);
    });

    it('accepts an optional valueSchemaId on produce', () => {
      const ok = KafkaProduceSchema.safeParse({
        connectionId: 'abc',
        topic: 't',
        value: '{"id":1}',
        acks: 1,
        valueSchemaId: 7,
      });
      expect(ok.success).toBe(true);
      const bad = KafkaProduceSchema.safeParse({
        connectionId: 'abc',
        topic: 't',
        value: '{}',
        acks: 1,
        valueSchemaId: 0,
      });
      expect(bad.success).toBe(false);
    });

    it('requires SASL block for SASL_PLAINTEXT', () => {
      const result = KafkaConnectSchema.safeParse({
        connectionId: 'abc',
        clientId: 'r',
        bootstrapBrokers: ['localhost:9092'],
        auth: { securityProtocol: 'SASL_PLAINTEXT' },
      });
      expect(result.success).toBe(false);
    });

    it('accepts SASL_SSL with sasl + optional tls', () => {
      const result = KafkaConnectSchema.safeParse({
        connectionId: 'abc',
        clientId: 'r',
        bootstrapBrokers: ['kafka.example.com:9093'],
        auth: {
          securityProtocol: 'SASL_SSL',
          sasl: { mechanism: 'SCRAM-SHA-512', username: 'u', password: 'p' },
        },
      });
      expect(result.success).toBe(true);
    });

    it('rejects unknown SASL mechanism', () => {
      const result = KafkaConnectSchema.safeParse({
        connectionId: 'abc',
        clientId: 'r',
        bootstrapBrokers: ['localhost:9092'],
        auth: {
          securityProtocol: 'SASL_PLAINTEXT',
          sasl: { mechanism: 'KERBEROS', username: 'u', password: 'p' },
        },
      });
      expect(result.success).toBe(false);
    });

    it('rejects bad broker syntax', () => {
      const result = KafkaConnectSchema.safeParse({
        connectionId: 'abc',
        clientId: 'r',
        bootstrapBrokers: ['not a broker'],
        auth: { securityProtocol: 'PLAINTEXT' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects more than 32 brokers', () => {
      const result = KafkaConnectSchema.safeParse({
        connectionId: 'abc',
        clientId: 'r',
        bootstrapBrokers: Array.from({ length: 33 }, (_, i) => `host${i}:9092`),
        auth: { securityProtocol: 'PLAINTEXT' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects connection ids with invalid characters', () => {
      const result = KafkaConnectSchema.safeParse({
        connectionId: 'has spaces',
        clientId: 'r',
        bootstrapBrokers: ['localhost:9092'],
        auth: { securityProtocol: 'PLAINTEXT' },
      });
      expect(result.success).toBe(false);
    });

    it('accepts an optional idempotent flag', () => {
      const result = KafkaConnectSchema.safeParse({
        connectionId: 'abc',
        clientId: 'r',
        bootstrapBrokers: ['localhost:9092'],
        auth: { securityProtocol: 'PLAINTEXT' },
        idempotent: true,
      });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.idempotent).toBe(true);
    });

    it('rejects a non-boolean idempotent flag', () => {
      const result = KafkaConnectSchema.safeParse({
        connectionId: 'abc',
        clientId: 'r',
        bootstrapBrokers: ['localhost:9092'],
        auth: { securityProtocol: 'PLAINTEXT' },
        idempotent: 'yes',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('KafkaProduceSchema', () => {
    const base = {
      connectionId: 'c',
      topic: 'orders',
      value: 'hello',
      acks: 1 as const,
    };

    it('accepts minimal produce config', () => {
      const result = KafkaProduceSchema.safeParse(base);
      expect(result.success).toBe(true);
    });

    it('accepts key, headers, partition, compression', () => {
      const result = KafkaProduceSchema.safeParse({
        ...base,
        key: 'order-1',
        headers: { source: 'web' },
        partition: 2,
        compression: 'snappy',
      });
      expect(result.success).toBe(true);
    });

    it('rejects empty topic', () => {
      const result = KafkaProduceSchema.safeParse({ ...base, topic: '' });
      expect(result.success).toBe(false);
    });

    it('rejects topic with invalid characters', () => {
      const result = KafkaProduceSchema.safeParse({ ...base, topic: 'has spaces' });
      expect(result.success).toBe(false);
    });

    it('rejects negative partition', () => {
      const result = KafkaProduceSchema.safeParse({ ...base, partition: -1 });
      expect(result.success).toBe(false);
    });

    it('rejects acks outside {0, 1, -1}', () => {
      const result = KafkaProduceSchema.safeParse({ ...base, acks: 2 });
      expect(result.success).toBe(false);
    });

    it('rejects oversized value (>10MB)', () => {
      const result = KafkaProduceSchema.safeParse({
        ...base,
        value: 'a'.repeat(11 * 1024 * 1024),
      });
      expect(result.success).toBe(false);
    });
  });

  describe('KafkaSubscribeSchema', () => {
    it('accepts a valid subscribe', () => {
      const result = KafkaSubscribeSchema.safeParse({
        connectionId: 'c',
        groupId: 'restura-g',
        topics: ['orders', 'logs'],
        fromBeginning: true,
      });
      expect(result.success).toBe(true);
    });

    it('requires at least one topic', () => {
      const result = KafkaSubscribeSchema.safeParse({
        connectionId: 'c',
        groupId: 'g',
        topics: [],
        fromBeginning: false,
      });
      expect(result.success).toBe(false);
    });

    it('caps at 50 topics', () => {
      const result = KafkaSubscribeSchema.safeParse({
        connectionId: 'c',
        groupId: 'g',
        topics: Array.from({ length: 51 }, (_, i) => `t${i}`),
        fromBeginning: false,
      });
      expect(result.success).toBe(false);
    });

    it('accepts an explicit mode', () => {
      const result = KafkaSubscribeSchema.safeParse({
        connectionId: 'c',
        groupId: 'g',
        topics: ['orders'],
        fromBeginning: false,
        mode: 'manual',
      });
      expect(result.success).toBe(true);
    });

    it('rejects an unknown mode', () => {
      const result = KafkaSubscribeSchema.safeParse({
        connectionId: 'c',
        groupId: 'g',
        topics: ['orders'],
        fromBeginning: false,
        mode: 'tail',
      });
      expect(result.success).toBe(false);
    });

    it('accepts a per-partition offset spec (numeric string offset)', () => {
      const result = KafkaSubscribeSchema.safeParse({
        connectionId: 'c',
        groupId: 'g',
        topics: ['orders'],
        fromBeginning: false,
        mode: 'manual',
        offsets: [{ topic: 'orders', partition: 0, offset: '42' }],
      });
      expect(result.success).toBe(true);
    });

    it('rejects a non-numeric offset', () => {
      const result = KafkaSubscribeSchema.safeParse({
        connectionId: 'c',
        groupId: 'g',
        topics: ['orders'],
        fromBeginning: false,
        offsets: [{ topic: 'orders', partition: 0, offset: 'latest' }],
      });
      expect(result.success).toBe(false);
    });

    it('rejects a negative partition in the offset spec', () => {
      const result = KafkaSubscribeSchema.safeParse({
        connectionId: 'c',
        groupId: 'g',
        topics: ['orders'],
        fromBeginning: false,
        offsets: [{ topic: 'orders', partition: -1, offset: '0' }],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('Unsubscribe/Disconnect', () => {
    it('accepts a valid connection id', () => {
      expect(KafkaUnsubscribeSchema.safeParse({ connectionId: 'abc' }).success).toBe(true);
      expect(KafkaDisconnectSchema.safeParse({ connectionId: 'abc' }).success).toBe(true);
    });
  });

  describe('Admin schemas', () => {
    it('accepts list-topics / list-groups by connection id', () => {
      expect(KafkaListTopicsSchema.safeParse({ connectionId: 'c' }).success).toBe(true);
      expect(KafkaListGroupsSchema.safeParse({ connectionId: 'c' }).success).toBe(true);
    });

    it('accepts a valid create-topic config', () => {
      const result = KafkaCreateTopicSchema.safeParse({
        connectionId: 'c',
        topic: 'orders',
        partitions: 3,
        replicationFactor: 2,
      });
      expect(result.success).toBe(true);
    });

    it('rejects zero or negative partitions', () => {
      expect(
        KafkaCreateTopicSchema.safeParse({
          connectionId: 'c',
          topic: 'orders',
          partitions: 0,
          replicationFactor: 1,
        }).success
      ).toBe(false);
      expect(
        KafkaCreateTopicSchema.safeParse({
          connectionId: 'c',
          topic: 'orders',
          partitions: -1,
          replicationFactor: 1,
        }).success
      ).toBe(false);
    });

    it('rejects partitions / replication above the sane cap', () => {
      expect(
        KafkaCreateTopicSchema.safeParse({
          connectionId: 'c',
          topic: 'orders',
          partitions: 10_001,
          replicationFactor: 1,
        }).success
      ).toBe(false);
      expect(
        KafkaCreateTopicSchema.safeParse({
          connectionId: 'c',
          topic: 'orders',
          partitions: 1,
          replicationFactor: 17,
        }).success
      ).toBe(false);
    });

    it('rejects an invalid topic name in create/delete', () => {
      expect(
        KafkaCreateTopicSchema.safeParse({
          connectionId: 'c',
          topic: 'has spaces',
          partitions: 1,
          replicationFactor: 1,
        }).success
      ).toBe(false);
      expect(
        KafkaDeleteTopicSchema.safeParse({ connectionId: 'c', topic: 'has spaces' }).success
      ).toBe(false);
    });

    it('accepts a valid delete-topic config', () => {
      expect(KafkaDeleteTopicSchema.safeParse({ connectionId: 'c', topic: 'orders' }).success).toBe(
        true
      );
    });
  });
});
