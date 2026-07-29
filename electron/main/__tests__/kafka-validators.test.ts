import { describe, expect, it } from 'vitest';
import {
  KafkaConnectSchema,
  KafkaAlterQuotasSchema,
  KafkaAlterTopicConfigsSchema,
  KafkaCreateAclSchema,
  KafkaCreatePartitionsSchema,
  KafkaDeleteAclsSchema,
  KafkaDeleteRecordsSchema,
  KafkaCreateTopicSchema,
  KafkaDeleteGroupSchema,
  KafkaDeleteTopicSchema,
  KafkaDisconnectSchema,
  KafkaInspectGroupSchema,
  KafkaInspectTopicSchema,
  KafkaListGroupsSchema,
  KafkaListTopicsSchema,
  KafkaProduceSchema,
  KafkaProduceBatchSchema,
  KafkaProducerStreamOpenSchema,
  KafkaProducerStreamWriteSchema,
  KafkaTransactionBeginSchema,
  KafkaTransactionEndSchema,
  KafkaResetGroupOffsetsSchema,
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

    it('accepts optional Schema Registry Basic auth but rejects unsupported bearer tokens', () => {
      const result = KafkaConnectSchema.safeParse({
        connectionId: 'abc',
        clientId: 'r',
        bootstrapBrokers: ['localhost:9092'],
        auth: { securityProtocol: 'PLAINTEXT' },
        registry: {
          url: 'https://schema-registry:8081',
          auth: { username: 'u', password: 'p' },
        },
      });
      expect(result.success).toBe(true);
      expect(
        KafkaConnectSchema.safeParse({
          connectionId: 'abc',
          clientId: 'r',
          bootstrapBrokers: ['localhost:9092'],
          auth: { securityProtocol: 'PLAINTEXT' },
          registry: { url: 'https://schema-registry:8081', auth: { token: 't' } },
        }).success
      ).toBe(false);
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
        record: {
          topic: 't',
          value: { encoding: 'schema', schemaId: 7, data: '{"id":1}' },
        },
        acks: 1,
      });
      expect(ok.success).toBe(true);
      const bad = KafkaProduceSchema.safeParse({
        connectionId: 'abc',
        record: {
          topic: 't',
          value: { encoding: 'schema', schemaId: 0, data: '{}' },
        },
        acks: 1,
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

    it('accepts OAUTHBEARER with a static token and rejects username/password shape', () => {
      const base = {
        connectionId: 'abc',
        clientId: 'r',
        bootstrapBrokers: ['localhost:9092'],
      };
      expect(
        KafkaConnectSchema.safeParse({
          ...base,
          auth: {
            securityProtocol: 'SASL_SSL',
            sasl: { mechanism: 'OAUTHBEARER', token: 'signed-token' },
          },
        }).success
      ).toBe(true);
      expect(
        KafkaConnectSchema.safeParse({
          ...base,
          auth: {
            securityProtocol: 'SASL_SSL',
            sasl: { mechanism: 'OAUTHBEARER', username: 'u', password: 'p' },
          },
        }).success
      ).toBe(false);
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

    it('accepts only broker ports in the 1-65535 range', () => {
      const base = {
        connectionId: 'abc',
        clientId: 'r',
        auth: { securityProtocol: 'PLAINTEXT' as const },
      };

      expect(
        KafkaConnectSchema.safeParse({ ...base, bootstrapBrokers: ['broker.example:65535'] })
          .success
      ).toBe(true);
      for (const broker of ['broker.example:0', 'broker.example:65536', 'broker.example:99999']) {
        const result = KafkaConnectSchema.safeParse({ ...base, bootstrapBrokers: [broker] });
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues).toContainEqual(
            expect.objectContaining({ message: 'Broker port must be between 1 and 65535' })
          );
        }
      }
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
      record: {
        topic: 'orders',
        value: { encoding: 'utf8' as const, data: 'hello' },
      },
      acks: 1 as const,
    };

    it('accepts minimal produce config', () => {
      const result = KafkaProduceSchema.safeParse(base);
      expect(result.success).toBe(true);
    });

    it('accepts key, headers, partition, compression', () => {
      const result = KafkaProduceSchema.safeParse({
        ...base,
        record: {
          topic: 'orders',
          key: { encoding: 'utf8', data: 'order-1' },
          value: { encoding: 'base64', data: 'AA==' },
          headers: [
            {
              key: { encoding: 'utf8', data: 'source' },
              value: { encoding: 'base64', data: 'd2Vi' },
            },
          ],
          partition: 2,
          timestamp: '1722222222000',
        },
        compression: 'snappy',
      });
      expect(result.success).toBe(true);
    });

    it('accepts empty and tombstone values without conflating them', () => {
      expect(
        KafkaProduceSchema.safeParse({
          ...base,
          record: { topic: 'orders', value: { encoding: 'utf8', data: '' } },
        }).success
      ).toBe(true);
      expect(
        KafkaProduceSchema.safeParse({
          ...base,
          record: { topic: 'orders', value: { encoding: 'null' } },
        }).success
      ).toBe(true);
    });

    it('accepts schema fields and rejects malformed Base64', () => {
      expect(
        KafkaProduceSchema.safeParse({
          ...base,
          record: {
            topic: 'orders',
            value: { encoding: 'schema', schemaId: 7, data: '{"id":1}' },
          },
        }).success
      ).toBe(true);
      expect(
        KafkaProduceSchema.safeParse({
          ...base,
          record: { topic: 'orders', value: { encoding: 'base64', data: '@@' } },
        }).success
      ).toBe(false);
    });

    it('rejects empty topic', () => {
      const result = KafkaProduceSchema.safeParse({
        ...base,
        record: { ...base.record, topic: '' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects topic with invalid characters', () => {
      const result = KafkaProduceSchema.safeParse({
        ...base,
        record: { ...base.record, topic: 'has spaces' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects negative partition', () => {
      const result = KafkaProduceSchema.safeParse({
        ...base,
        record: { ...base.record, partition: -1 },
      });
      expect(result.success).toBe(false);
    });

    it('rejects acks outside {0, 1, -1}', () => {
      const result = KafkaProduceSchema.safeParse({ ...base, acks: 2 });
      expect(result.success).toBe(false);
    });

    it('rejects oversized value (>10MB)', () => {
      const result = KafkaProduceSchema.safeParse({
        ...base,
        record: {
          topic: 'orders',
          value: { encoding: 'utf8', data: 'a'.repeat(11 * 1024 * 1024) },
        },
      });
      expect(result.success).toBe(false);
    });

    it('bounds interactive batches', () => {
      const record = base.record;
      expect(
        KafkaProduceBatchSchema.safeParse({
          connectionId: 'c',
          records: [record, record],
          acks: -1,
        }).success
      ).toBe(true);
      expect(
        KafkaProduceBatchSchema.safeParse({
          connectionId: 'c',
          records: [],
          acks: -1,
        }).success
      ).toBe(false);
    });

    it('validates producer stream lifecycle inputs', () => {
      expect(
        KafkaProducerStreamOpenSchema.safeParse({
          connectionId: 'c',
          batchSize: 50,
          batchTime: 250,
          highWaterMark: 100,
          acks: 1,
        }).success
      ).toBe(true);
      expect(
        KafkaProducerStreamWriteSchema.safeParse({
          connectionId: 'c',
          record: base.record,
        }).success
      ).toBe(true);
    });

    it('validates transaction begin and end actions', () => {
      expect(
        KafkaTransactionBeginSchema.safeParse({
          connectionId: 'c',
        }).success
      ).toBe(true);
      expect(
        KafkaTransactionEndSchema.safeParse({
          connectionId: 'c',
          action: 'commit',
        }).success
      ).toBe(true);
      expect(
        KafkaTransactionEndSchema.safeParse({
          connectionId: 'c',
          action: 'discard',
        }).success
      ).toBe(false);
    });
  });

  describe('KafkaSubscribeSchema', () => {
    it('accepts a valid subscribe', () => {
      const result = KafkaSubscribeSchema.safeParse({
        connectionId: 'c',
        groupId: 'restura-g',
        topics: ['orders', 'logs'],
        mode: 'committed',
        fallbackMode: 'latest',
      });
      expect(result.success).toBe(true);
    });

    it('requires at least one topic', () => {
      const result = KafkaSubscribeSchema.safeParse({
        connectionId: 'c',
        groupId: 'g',
        topics: [],
        mode: 'committed',
      });
      expect(result.success).toBe(false);
    });

    it('caps at 50 topics', () => {
      const result = KafkaSubscribeSchema.safeParse({
        connectionId: 'c',
        groupId: 'g',
        topics: Array.from({ length: 51 }, (_, i) => `t${i}`),
        mode: 'committed',
      });
      expect(result.success).toBe(false);
    });

    it('requires offsets for manual mode', () => {
      const result = KafkaSubscribeSchema.safeParse({
        connectionId: 'c',
        groupId: 'g',
        topics: ['orders'],
        mode: 'manual',
      });
      expect(result.success).toBe(false);
    });

    it('rejects an unknown mode', () => {
      const result = KafkaSubscribeSchema.safeParse({
        connectionId: 'c',
        groupId: 'g',
        topics: ['orders'],
        mode: 'tail',
      });
      expect(result.success).toBe(false);
    });

    it('accepts a per-partition offset spec (numeric string offset)', () => {
      const result = KafkaSubscribeSchema.safeParse({
        connectionId: 'c',
        groupId: 'g',
        topics: ['orders'],
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
        mode: 'manual',
        offsets: [{ topic: 'orders', partition: 0, offset: 'latest' }],
      });
      expect(result.success).toBe(false);
    });

    it('rejects a negative partition in the offset spec', () => {
      const result = KafkaSubscribeSchema.safeParse({
        connectionId: 'c',
        groupId: 'g',
        topics: ['orders'],
        mode: 'manual',
        offsets: [{ topic: 'orders', partition: -1, offset: '0' }],
      });
      expect(result.success).toBe(false);
    });

    it('accepts the timestamp mode with an epoch-ms numeric string', () => {
      const result = KafkaSubscribeSchema.safeParse({
        connectionId: 'c',
        groupId: 'g',
        topics: ['orders'],
        mode: 'timestamp',
        timestamp: '1718800000000',
      });
      expect(result.success).toBe(true);
    });

    it('rejects a non-numeric timestamp', () => {
      const result = KafkaSubscribeSchema.safeParse({
        connectionId: 'c',
        groupId: 'g',
        topics: ['orders'],
        mode: 'timestamp',
        timestamp: 'yesterday',
      });
      expect(result.success).toBe(false);
    });

    it('accepts manual commit, read-committed isolation, consumer protocol, and fetch tuning', () => {
      expect(
        KafkaSubscribeSchema.safeParse({
          connectionId: 'c',
          groupId: 'g',
          topics: ['orders'],
          mode: 'committed',
          fallbackMode: 'earliest',
          commitPolicy: 'manual',
          isolation: 'read-committed',
          groupProtocol: 'consumer',
          groupRemoteAssignor: 'uniform',
          maxBytes: 1_048_576,
          highWaterMark: 100,
          lagIntervalMs: 1000,
        }).success
      ).toBe(true);
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

    it('defaults topic mutations to validate-only and requires typed confirmation to apply', () => {
      expect(
        KafkaCreatePartitionsSchema.safeParse({
          connectionId: 'c',
          topic: 'orders',
          count: 8,
        }).success
      ).toBe(true);
      expect(
        KafkaAlterTopicConfigsSchema.safeParse({
          connectionId: 'c',
          topic: 'orders',
          configs: [{ name: 'retention.ms', operation: 'set', value: '60000' }],
          validateOnly: false,
          confirmation: 'wrong',
        }).success
      ).toBe(false);
      expect(
        KafkaAlterTopicConfigsSchema.safeParse({
          connectionId: 'c',
          topic: 'orders',
          configs: [{ name: 'retention.ms', operation: 'set', value: '60000' }],
          validateOnly: false,
          confirmation: 'ALTER orders',
        }).success
      ).toBe(true);
    });

    it('requires topic-specific confirmation before deleting records', () => {
      const base = {
        connectionId: 'c',
        topic: 'orders',
        partitions: [{ partition: 0, offset: '42' }],
      };
      expect(
        KafkaDeleteRecordsSchema.safeParse({
          ...base,
          confirmation: 'DELETE RECORDS orders',
        }).success
      ).toBe(true);
      expect(KafkaDeleteRecordsSchema.safeParse({ ...base, confirmation: 'orders' }).success).toBe(
        false
      );
    });

    it('guards ACL and quota changes with typed confirmation or validate-only', () => {
      const acl = {
        resourceType: 2,
        resourceName: 'orders',
        resourcePatternType: 3,
        principal: 'User:restura',
        host: '*',
        operation: 3,
        permissionType: 3,
      };
      expect(
        KafkaCreateAclSchema.safeParse({
          connectionId: 'c',
          acl,
          confirmation: 'CREATE ACL',
        }).success
      ).toBe(true);
      expect(
        KafkaDeleteAclsSchema.safeParse({
          connectionId: 'c',
          filter: acl,
          confirmation: 'no',
        }).success
      ).toBe(false);
      expect(
        KafkaAlterQuotasSchema.safeParse({
          connectionId: 'c',
          entities: [{ entityType: 'user', entityName: 'restura' }],
          operations: [{ key: 'producer_byte_rate', value: 1024 }],
        }).success
      ).toBe(true);
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

    it('accepts inspect-topic / inspect-group / delete-group configs', () => {
      expect(
        KafkaInspectTopicSchema.safeParse({ connectionId: 'c', topic: 'orders' }).success
      ).toBe(true);
      expect(KafkaInspectGroupSchema.safeParse({ connectionId: 'c', groupId: 'g' }).success).toBe(
        true
      );
      expect(KafkaDeleteGroupSchema.safeParse({ connectionId: 'c', groupId: 'g' }).success).toBe(
        true
      );
    });

    it('rejects an invalid topic name in inspect-topic', () => {
      expect(
        KafkaInspectTopicSchema.safeParse({ connectionId: 'c', topic: 'has spaces' }).success
      ).toBe(false);
    });

    it('rejects an empty group id in inspect/delete group', () => {
      expect(KafkaInspectGroupSchema.safeParse({ connectionId: 'c', groupId: '' }).success).toBe(
        false
      );
      expect(KafkaDeleteGroupSchema.safeParse({ connectionId: 'c', groupId: '' }).success).toBe(
        false
      );
    });

    it('accepts reset-group-offsets to earliest/latest without explicit partitions', () => {
      expect(
        KafkaResetGroupOffsetsSchema.safeParse({
          connectionId: 'c',
          groupId: 'g',
          topic: 'orders',
          to: 'latest',
        }).success
      ).toBe(true);
    });

    it('accepts reset-group-offsets to specific with per-partition offsets', () => {
      expect(
        KafkaResetGroupOffsetsSchema.safeParse({
          connectionId: 'c',
          groupId: 'g',
          topic: 'orders',
          to: 'specific',
          partitions: [{ partition: 0, offset: '100' }],
        }).success
      ).toBe(true);
    });

    it('rejects reset-group-offsets to specific without partitions', () => {
      expect(
        KafkaResetGroupOffsetsSchema.safeParse({
          connectionId: 'c',
          groupId: 'g',
          topic: 'orders',
          to: 'specific',
        }).success
      ).toBe(false);
    });

    it('rejects a non-numeric offset in reset-group-offsets', () => {
      expect(
        KafkaResetGroupOffsetsSchema.safeParse({
          connectionId: 'c',
          groupId: 'g',
          topic: 'orders',
          to: 'specific',
          partitions: [{ partition: 0, offset: 'latest' }],
        }).success
      ).toBe(false);
    });
  });
});
