import { describe, expect, it } from 'vitest';
import {
  KafkaAlterQuotasSchema,
  KafkaAlterTopicConfigsSchema,
  KafkaConnectSchema,
  KafkaCreateAclSchema,
  KafkaCreatePartitionsSchema,
  KafkaCreateTopicSchema,
  KafkaDeleteAclsSchema,
  KafkaDeleteGroupSchema,
  KafkaDeleteRecordsSchema,
  KafkaDeleteTopicSchema,
  KafkaDisconnectSchema,
  KafkaInspectGroupSchema,
  KafkaInspectTopicSchema,
  KafkaListGroupsSchema,
  KafkaListTopicsSchema,
  KafkaProduceBatchSchema,
  KafkaProducerStreamOpenSchema,
  KafkaProducerStreamWriteSchema,
  KafkaProduceSchema,
  KafkaResetGroupOffsetsSchema,
  KafkaSubscribeSchema,
  KafkaTransactionBeginSchema,
  KafkaTransactionEndSchema,
  KafkaUnsubscribeSchema,
} from '../ipc/ipc-validators';

describe('Kafka IPC validators', () => {
  describe('KafkaConnectSchema', () => {
    describe('IPv6 broker literals (#945)', () => {
      const parse = (broker: string) =>
        KafkaConnectSchema.safeParse({
          connectionId: 'abc',
          clientId: 'r',
          bootstrapBrokers: [broker],
          auth: { securityProtocol: 'PLAINTEXT' },
        }).success;

      it.each([
        '[2001:db8::1]:9092',
        '[::1]:9092',
        '[2001:db8::10]:9093',
        '[::ffff:127.0.0.1]:9092',
      ])('accepts %s', (broker) => expect(parse(broker)).toBe(true));

      it.each([
        '[::1]',
        '[:::]:9092',
        '[1:2:3:4:5:6:7:8:9]:9092',
        '[1.2.3.4]:9092',
        '[fe80::1%25eth0]:9092',
        '::1:9092',
        '[::1]:99999',
        '[::1]:0',
        '[zz::1]:9092',
        '[]:9092',
        '[::1]:9092:1',
        '[::1]x:9092',
        '[::1:9092',
        'host:99999',
      ])('rejects %s', (broker) => expect(parse(broker)).toBe(false));
    });

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

    describe('SASL mechanisms beyond PLAIN/SCRAM (#918)', () => {
      const base = { connectionId: 'abc', clientId: 'r', bootstrapBrokers: ['b:9092'] };
      const parse = (
        sasl: unknown,
        securityProtocol = 'SASL_SSL',
        bootstrapBrokers: string[] = base.bootstrapBrokers
      ) =>
        KafkaConnectSchema.safeParse({
          ...base,
          bootstrapBrokers,
          auth: { securityProtocol, sasl },
        }).success;
      const mskUsEast = ['b-1.demo.abc123.c2.kafka.us-east-1.amazonaws.com:9098'];
      const handle = { kind: 'handle', id: '00000000-0000-4000-8000-000000000001' };

      it('accepts OAUTHBEARER client-credentials with a SecretRef client secret', () => {
        const cc = {
          mechanism: 'OAUTHBEARER',
          mode: 'client-credentials',
          tokenEndpoint: 'https://idp.example.com/oauth2/token',
          clientId: 'kafka',
          clientSecret: handle,
          scope: 'kafka:produce',
          extensions: { logicalCluster: 'lkc-1' },
        };
        expect(parse(cc)).toBe(true);
        expect(parse({ ...cc, mode: undefined })).toBe(false);
        expect(parse({ ...cc, tokenEndpoint: 'ftp://idp.example.com/token' })).toBe(false);
        expect(parse({ ...cc, clientSecret: '' })).toBe(false);
        expect(parse({ ...cc, clientSecret: { kind: 'inline', value: '' } })).toBe(false);
        expect(parse({ ...cc, clientSecret: undefined })).toBe(false);
        // An explicit static mode keeps the legacy token shape.
        expect(parse({ mechanism: 'OAUTHBEARER', mode: 'static', token: 't' })).toBe(true);
      });

      it('accepts GSSAPI with validated Kerberos names', () => {
        expect(parse({ mechanism: 'GSSAPI' })).toBe(true);
        expect(
          parse({ mechanism: 'GSSAPI', serviceName: 'kafka', principal: 'svc/host@CORP.EXAMPLE' })
        ).toBe(true);
        expect(parse({ mechanism: 'GSSAPI', serviceName: 'kafka@evil' })).toBe(false);
        expect(parse({ mechanism: 'GSSAPI', principal: 'bad principal' })).toBe(false);
      });

      it('accepts AWS_MSK_IAM with static handles or a named profile, over SASL_SSL only', () => {
        const staticCreds = {
          mechanism: 'AWS_MSK_IAM',
          region: 'us-east-1',
          credentials: {
            source: 'static',
            accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
            secretAccessKey: handle,
            sessionToken: handle,
          },
        };
        expect(parse(staticCreds, 'SASL_SSL', mskUsEast)).toBe(true);
        expect(
          parse(
            {
              mechanism: 'AWS_MSK_IAM',
              region: 'eu-west-1',
              credentials: { source: 'profile', profile: 'msk-dev' },
            },
            'SASL_SSL',
            ['boot-x.c1.kafka-serverless.eu-west-1.amazonaws.com:9098']
          )
        ).toBe(true);
        expect(parse({ ...staticCreds, region: 'not a region' }, 'SASL_SSL', mskUsEast)).toBe(
          false
        );
        expect(
          parse(
            { ...staticCreds, credentials: { ...staticCreds.credentials, accessKeyId: 'lower' } },
            'SASL_SSL',
            mskUsEast
          )
        ).toBe(false);
        expect(parse(staticCreds, 'SASL_PLAINTEXT', mskUsEast)).toBe(false);
      });

      it('binds AWS_MSK_IAM to MSK broker hosts in the signer region unless explicitly opted out', () => {
        const msk = {
          mechanism: 'AWS_MSK_IAM',
          region: 'us-east-1',
          credentials: { source: 'profile', profile: 'default' },
        };
        // Arbitrary broker: a signed token for the ambient AWS identity must not go there.
        expect(parse(msk, 'SASL_SSL', ['attacker.example:9098'])).toBe(false);
        // Mixed list: one non-MSK broker is enough to refuse.
        expect(parse(msk, 'SASL_SSL', [...mskUsEast, 'attacker.example:9098'])).toBe(false);
        // Region mismatch between broker host and signer.
        expect(parse(msk, 'SASL_SSL', ['b-1.demo.c2.kafka.us-west-2.amazonaws.com:9098'])).toBe(
          false
        );
        // Explicit opt-in for PrivateLink / custom DNS.
        expect(
          parse({ ...msk, allowNonAwsBrokerHosts: true }, 'SASL_SSL', ['msk.internal.corp:9098'])
        ).toBe(true);
        expect(
          parse({ ...msk, allowNonAwsBrokerHosts: false }, 'SASL_SSL', ['msk.internal.corp:9098'])
        ).toBe(false);
      });

      it('requires https token endpoints except for loopback / private IP literals', () => {
        const cc = (tokenEndpoint: string) => ({
          mechanism: 'OAUTHBEARER',
          mode: 'client-credentials',
          tokenEndpoint,
          clientId: 'c',
          clientSecret: handle,
        });
        expect(parse(cc('https://idp.example.com/token'))).toBe(true);
        expect(parse(cc('http://idp.example.com/token'))).toBe(false);
        expect(parse(cc('http://localhost:8080/realms/x/token'))).toBe(true);
        expect(parse(cc('http://10.0.0.5/token'))).toBe(true);
      });

      it('rejects control characters in OAuth extensions and caps their number', () => {
        const withExt = (extensions: Record<string, string>) => ({
          mechanism: 'OAUTHBEARER',
          token: 't',
          extensions,
        });
        expect(parse(withExt({ logicalCluster: 'lkc-1' }))).toBe(true);
        expect(parse(withExt({ a: 'x\x01auth=Bearer forged' }))).toBe(false);
        expect(parse(withExt({ 'a\nb': 'x' }))).toBe(false);
        // RFC 7628: letters-only keys; `auth` is the authenticator's own field.
        // Non-empty values are an application limit (RFC allows empty, Apache Kafka rejects it).
        expect(parse(withExt({ auth: 'x' }))).toBe(false);
        expect(parse(withExt({ 'a=b': 'x' }))).toBe(false);
        expect(parse(withExt({ 'logical-cluster': 'x' }))).toBe(false);
        expect(parse(withExt({ a: '' }))).toBe(false);
        expect(parse(withExt({ a: 'tab\tok' }))).toBe(true);
        const letterKey = (i: number) =>
          `k${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`;
        const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [letterKey(i), 'v']));
        expect(parse(withExt(many))).toBe(false);
        const max = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [letterKey(i), 'v']));
        expect(parse(withExt(max))).toBe(true);
      });
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
