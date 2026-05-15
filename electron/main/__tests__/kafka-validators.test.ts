import { describe, expect, it } from 'vitest';
import {
  KafkaConnectSchema,
  KafkaDisconnectSchema,
  KafkaProduceSchema,
  KafkaSubscribeSchema,
  KafkaUnsubscribeSchema,
} from '../ipc-validators';

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
  });

  describe('Unsubscribe/Disconnect', () => {
    it('accepts a valid connection id', () => {
      expect(KafkaUnsubscribeSchema.safeParse({ connectionId: 'abc' }).success).toBe(true);
      expect(KafkaDisconnectSchema.safeParse({ connectionId: 'abc' }).success).toBe(true);
    });
  });
});
