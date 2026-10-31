import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kafkaManager } from '@/features/kafka/lib/kafkaManager';
import { KAFKA_SECRET_SENTINEL, useKafkaStore } from '@/features/kafka/store/useKafkaStore';
import { KAFKA_CHANNEL, kafkaChannel } from '../../../../../electron/shared/kafka-channels';

function installElectron(opts: { isElectron?: boolean } = {}) {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const fn = () => vi.fn();
  const kafka = {
    connect: vi.fn(async () => ({ success: true as const })),
    produce: fn(),
    subscribe: vi.fn(async () => ({ success: true as const })),
    unsubscribe: vi.fn(async () => ({ success: true })),
    disconnect: vi.fn(async () => ({ success: true })),
    listTopics: fn(),
    createTopic: fn(),
    deleteTopic: fn(),
    listGroups: fn(),
    inspectTopic: fn(),
    inspectGroup: fn(),
    resetGroupOffsets: fn(),
    deleteGroup: fn(),
    deleteGroupOffsets: fn(),
    on: (channel: string, cb: (...args: unknown[]) => void) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), cb]);
    },
    removeListener: vi.fn(),
    removeAllListeners: (channel: string) => listeners.delete(channel),
  };
  Object.defineProperty(window, 'electron', {
    value: { isElectron: opts.isElectron ?? true, kafka },
    configurable: true,
  });
  return {
    kafka,
    emit: (channel: string, payload: unknown) => {
      for (const l of listeners.get(channel) ?? []) l(payload);
    },
  };
}

function resetStore(): void {
  useKafkaStore.setState({
    connections: {},
    activeConnectionId: null,
    connectionByTabId: {},
    messageFilter: 'all',
    searchQuery: '',
  });
}

function lastMessage(id: string) {
  const msgs = useKafkaStore.getState().connections[id]?.messages ?? [];
  return msgs[msgs.length - 1];
}

describe('kafkaManager branches', () => {
  beforeEach(resetStore);
  afterEach(() => {
    delete (window as unknown as { electron?: unknown }).electron;
  });

  describe('without Electron', () => {
    it('refuses connect/produce/subscribe outside the desktop app', async () => {
      const id = useKafkaStore.getState().createConnection();
      const conn = useKafkaStore.getState().connections[id]!;
      await expect(kafkaManager.connect(conn)).resolves.toEqual({
        ok: false,
        error: 'Kafka is only available in the Restura desktop app.',
      });
      await expect(
        kafkaManager.produce({ connectionId: id, topic: 't', value: 'v', acks: 1 })
      ).resolves.toEqual({ ok: false, error: 'Kafka is desktop-only.' });
      await expect(
        kafkaManager.subscribe({
          connectionId: id,
          groupId: 'g',
          topics: ['t'],
          fromBeginning: false,
        })
      ).resolves.toEqual({ ok: false, error: 'Kafka is desktop-only.' });
    });

    it('returns early from unsubscribe/disconnect and reports admin calls as unavailable', async () => {
      await expect(kafkaManager.unsubscribe('c')).resolves.toBeUndefined();
      await expect(kafkaManager.disconnect('c')).resolves.toBeUndefined();
      const unavailable = { ok: false, error: 'Electron API unavailable.' };
      await expect(kafkaManager.listTopics('c')).resolves.toEqual(unavailable);
      await expect(
        kafkaManager.createTopic({
          connectionId: 'c',
          topic: 't',
          partitions: 1,
          replicationFactor: 1,
        })
      ).resolves.toEqual(unavailable);
      await expect(kafkaManager.deleteTopic('c', 't')).resolves.toEqual(unavailable);
      await expect(kafkaManager.listGroups('c')).resolves.toEqual(unavailable);
      await expect(kafkaManager.inspectTopic('c', 't')).resolves.toEqual(unavailable);
      await expect(kafkaManager.inspectGroup('c', 'g')).resolves.toEqual(unavailable);
      await expect(
        kafkaManager.resetGroupOffsets({
          connectionId: 'c',
          groupId: 'g',
          topic: 't',
          to: 'earliest',
        })
      ).resolves.toEqual(unavailable);
      await expect(
        kafkaManager.deleteGroupOffsets({ connectionId: 'c', groupId: 'g', topic: 't' })
      ).resolves.toEqual(unavailable);
      await expect(kafkaManager.deleteGroup('c', 'g')).resolves.toEqual(unavailable);
    });

    it('reports an unavailable API when flagged as Electron but the bridge lacks kafka listeners', async () => {
      Object.defineProperty(window, 'electron', {
        value: { isElectron: true },
        configurable: true,
      });
      const id = useKafkaStore.getState().createConnection();
      await expect(kafkaManager.unsubscribe(id)).rejects.toThrow();
    });
  });

  describe('admin error pass-through', () => {
    it('surfaces the main-process error text for each failing admin call', async () => {
      const { kafka } = installElectron();
      const failure = { success: false, error: 'broker said no' };
      for (const k of [
        kafka.listTopics,
        kafka.createTopic,
        kafka.deleteTopic,
        kafka.listGroups,
        kafka.inspectTopic,
        kafka.inspectGroup,
        kafka.resetGroupOffsets,
        kafka.deleteGroupOffsets,
        kafka.deleteGroup,
      ]) {
        k.mockResolvedValue(failure);
      }
      const bad = { ok: false, error: 'broker said no' };
      await expect(kafkaManager.listTopics('c')).resolves.toEqual(bad);
      await expect(
        kafkaManager.createTopic({
          connectionId: 'c',
          topic: 't',
          partitions: 1,
          replicationFactor: 1,
        })
      ).resolves.toEqual(bad);
      await expect(kafkaManager.deleteTopic('c', 't')).resolves.toEqual(bad);
      await expect(kafkaManager.listGroups('c')).resolves.toEqual(bad);
      await expect(kafkaManager.inspectTopic('c', 't')).resolves.toEqual(bad);
      await expect(kafkaManager.inspectGroup('c', 'g')).resolves.toEqual(bad);
      await expect(
        kafkaManager.resetGroupOffsets({
          connectionId: 'c',
          groupId: 'g',
          topic: 't',
          to: 'earliest',
        })
      ).resolves.toEqual(bad);
      await expect(
        kafkaManager.deleteGroupOffsets({ connectionId: 'c', groupId: 'g', topic: 't' })
      ).resolves.toEqual(bad);
      await expect(kafkaManager.deleteGroup('c', 'g')).resolves.toEqual(bad);
    });

    it('treats a successful response missing its payload as a failure', async () => {
      const { kafka } = installElectron();
      kafka.listTopics.mockResolvedValue({ success: true });
      kafka.listGroups.mockResolvedValue({ success: true });
      kafka.inspectTopic.mockResolvedValue({ success: true, partitions: [] });
      kafka.inspectGroup.mockResolvedValue({ success: true });
      await expect(kafkaManager.listTopics('c')).resolves.toEqual({
        ok: false,
        error: 'List topics failed',
      });
      await expect(kafkaManager.listGroups('c')).resolves.toEqual({
        ok: false,
        error: 'List groups failed',
      });
      await expect(kafkaManager.inspectTopic('c', 't')).resolves.toEqual({
        ok: false,
        error: 'Inspect topic failed',
      });
      await expect(kafkaManager.inspectGroup('c', 'g')).resolves.toEqual({
        ok: false,
        error: 'Inspect group failed',
      });
    });
  });

  describe('connect', () => {
    it('logs a system error when the main process rejects the connection', async () => {
      const { kafka } = installElectron();
      kafka.connect.mockResolvedValueOnce({ success: false, error: 'bad brokers' } as never);
      const id = useKafkaStore.getState().createConnection();
      const result = await kafkaManager.connect(useKafkaStore.getState().connections[id]!);
      expect(result).toEqual({ ok: false, error: 'bad brokers' });
      expect(useKafkaStore.getState().connections[id]!.status).toBe('disconnected');
      expect(lastMessage(id)?.error).toBe('bad brokers');
    });

    it('falls back to a generic message when connect fails without detail', async () => {
      const { kafka } = installElectron();
      kafka.connect.mockResolvedValueOnce({ success: false } as never);
      const id = useKafkaStore.getState().createConnection();
      const result = await kafkaManager.connect(useKafkaStore.getState().connections[id]!);
      expect(result).toEqual({ ok: false, error: 'Kafka connect failed' });
    });

    it('uses a generic message when connect rejects with a non-Error', async () => {
      const { kafka } = installElectron();
      kafka.connect.mockRejectedValueOnce('nope');
      const id = useKafkaStore.getState().createConnection();
      const result = await kafkaManager.connect(useKafkaStore.getState().connections[id]!);
      expect(result).toEqual({ ok: false, error: 'Kafka connect failed' });
    });

    it('reports a missing registry bearer token as a credential-resolution failure', async () => {
      installElectron();
      const id = useKafkaStore.getState().createConnection();
      const base = useKafkaStore.getState().connections[id]!;
      const result = await kafkaManager.connect({
        ...base,
        registry: { url: 'http://reg', authType: 'bearer', bearerToken: '' },
      } as typeof base);
      expect(result).toEqual({
        ok: false,
        error: 'Missing Schema Registry bearer token — re-enter it.',
      });
      expect(lastMessage(id)?.error).toContain('bearer token');
    });

    it('sends idempotent, transactionalId and basic registry auth to main', async () => {
      const { kafka } = installElectron();
      const id = useKafkaStore.getState().createConnection();
      const base = useKafkaStore.getState().connections[id]!;
      const result = await kafkaManager.connect({
        ...base,
        idempotent: true,
        transactionalId: 'tx-1',
        registry: { url: 'http://reg', auth: { username: 'u', password: 'p' } },
      } as typeof base);
      expect(result).toEqual({ ok: true });
      expect(kafka.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotent: true,
          transactionalId: 'tx-1',
          registry: { url: 'http://reg', auth: { username: 'u', password: 'p' } },
        })
      );
    });

    it('sends a registry without auth as a bare url, and an inline bearer token as-is', async () => {
      const { kafka } = installElectron();
      const id = useKafkaStore.getState().createConnection();
      const base = useKafkaStore.getState().connections[id]!;
      await kafkaManager.connect({ ...base, registry: { url: 'http://reg' } } as typeof base);
      expect(kafka.connect).toHaveBeenLastCalledWith(
        expect.objectContaining({ registry: { url: 'http://reg' } })
      );
      await kafkaManager.connect({
        ...base,
        registry: { url: 'http://reg', authType: 'bearer', bearerToken: 'tok' },
      } as typeof base);
      expect(kafka.connect).toHaveBeenLastCalledWith(
        expect.objectContaining({
          registry: { url: 'http://reg', auth: { type: 'bearer', token: 'tok' } },
        })
      );
    });

    it('treats a registry auth block with no credentials as unauthenticated', async () => {
      const { kafka } = installElectron();
      const id = useKafkaStore.getState().createConnection();
      const base = useKafkaStore.getState().connections[id]!;
      await kafkaManager.connect({
        ...base,
        registry: { url: 'http://reg', auth: { username: '', password: '' } },
      } as typeof base);
      expect(kafka.connect).toHaveBeenLastCalledWith(
        expect.objectContaining({ registry: { url: 'http://reg' } })
      );
    });

    it('fails with a re-enter message for a sentinel SASL password that was never stored', async () => {
      installElectron();
      const id = useKafkaStore.getState().createConnection();
      const base = useKafkaStore.getState().connections[id]!;
      const result = await kafkaManager.connect({
        ...base,
        auth: {
          securityProtocol: 'SASL_PLAINTEXT',
          sasl: { mechanism: 'PLAIN', username: 'u', password: KAFKA_SECRET_SENTINEL },
        },
      } as typeof base);
      expect(result.ok).toBe(false);
    });

    it('resolves SSL, SASL_PLAINTEXT and static OAuth auth shapes', async () => {
      const { kafka } = installElectron();
      const id = useKafkaStore.getState().createConnection();
      const base = useKafkaStore.getState().connections[id]!;

      await kafkaManager.connect({
        ...base,
        auth: { securityProtocol: 'SSL' },
      } as typeof base);
      expect(kafka.connect).toHaveBeenLastCalledWith(
        expect.objectContaining({ auth: { securityProtocol: 'SSL', tls: {} } })
      );

      await kafkaManager.connect({
        ...base,
        auth: {
          securityProtocol: 'SSL',
          tls: {
            rejectUnauthorized: false,
            caPath: '/ca',
            certPath: '/c',
            keyPath: '/k',
            passphrase: 'pp',
          },
        },
      } as typeof base);
      expect(kafka.connect).toHaveBeenLastCalledWith(
        expect.objectContaining({
          auth: {
            securityProtocol: 'SSL',
            tls: {
              rejectUnauthorized: false,
              caPath: '/ca',
              certPath: '/c',
              keyPath: '/k',
              passphrase: 'pp',
            },
          },
        })
      );

      await kafkaManager.connect({
        ...base,
        auth: {
          securityProtocol: 'SASL_PLAINTEXT',
          sasl: { mechanism: 'OAUTHBEARER', token: 'jwt', extensions: { a: 'b' } },
        },
      } as typeof base);
      expect(kafka.connect).toHaveBeenLastCalledWith(
        expect.objectContaining({
          auth: {
            securityProtocol: 'SASL_PLAINTEXT',
            sasl: { mechanism: 'OAUTHBEARER', token: 'jwt', extensions: { a: 'b' } },
          },
        })
      );

      await kafkaManager.connect({
        ...base,
        auth: {
          securityProtocol: 'SASL_SSL',
          sasl: { mechanism: 'PLAIN', username: 'u', password: 'p' },
        },
      } as typeof base);
      expect(kafka.connect).toHaveBeenLastCalledWith(
        expect.objectContaining({
          auth: {
            securityProtocol: 'SASL_SSL',
            sasl: { mechanism: 'PLAIN', username: 'u', password: 'p' },
          },
        })
      );
    });

    it('rejects SASL protocols with no SASL block, empty tokens and incomplete OAuth/IAM', async () => {
      installElectron();
      const id = useKafkaStore.getState().createConnection();
      const base = useKafkaStore.getState().connections[id]!;
      const attempt = async (auth: unknown) =>
        kafkaManager.connect({ ...base, auth } as typeof base);

      expect((await attempt({ securityProtocol: 'SASL_SSL' })).ok).toBe(false);
      expect(
        (
          await attempt({
            securityProtocol: 'SASL_SSL',
            sasl: { mechanism: 'OAUTHBEARER', token: '' },
          })
        ).ok
      ).toBe(false);
      expect(
        (
          await attempt({
            securityProtocol: 'SASL_SSL',
            sasl: {
              mechanism: 'OAUTHBEARER',
              tokenEndpoint: ' ',
              clientId: 'c',
              clientSecret: 's',
            },
          })
        ).ok
      ).toBe(false);
      expect(
        (
          await attempt({
            securityProtocol: 'SASL_SSL',
            sasl: { mechanism: 'AWS_MSK_IAM', region: ' ', credentialSource: 'profile' },
          })
        ).ok
      ).toBe(false);
      expect(
        (
          await attempt({
            securityProtocol: 'SASL_SSL',
            sasl: {
              mechanism: 'AWS_MSK_IAM',
              region: 'us-east-1',
              credentialSource: 'profile',
              profile: '',
            },
          })
        ).ok
      ).toBe(false);
      expect(
        (
          await attempt({
            securityProtocol: 'SASL_SSL',
            sasl: {
              mechanism: 'AWS_MSK_IAM',
              region: 'us-east-1',
              credentialSource: 'static',
              accessKeyId: '',
            },
          })
        ).ok
      ).toBe(false);
    });

    it('forwards client-credentials scope/extensions, GSSAPI names and MSK IAM variants', async () => {
      const { kafka } = installElectron();
      const id = useKafkaStore.getState().createConnection();
      const base = useKafkaStore.getState().connections[id]!;
      const sent = async (sasl: unknown) => {
        await kafkaManager.connect({
          ...base,
          auth: { securityProtocol: 'SASL_SSL', sasl },
        } as typeof base);
        const call = kafka.connect.mock.calls[kafka.connect.mock.calls.length - 1] as unknown as [
          { auth: { sasl: unknown } },
        ];
        return call[0].auth.sasl;
      };

      expect(
        await sent({
          mechanism: 'OAUTHBEARER',
          mode: 'client-credentials',
          tokenEndpoint: ' https://idp/token ',
          clientId: ' cid ',
          clientSecret: 'sec',
          scope: ' read ',
          extensions: { x: 'y' },
        })
      ).toEqual({
        mechanism: 'OAUTHBEARER',
        mode: 'client-credentials',
        tokenEndpoint: 'https://idp/token',
        clientId: 'cid',
        clientSecret: 'sec',
        scope: 'read',
        extensions: { x: 'y' },
      });
      expect(
        await sent({ mechanism: 'GSSAPI', serviceName: ' kafka ', principal: ' me@R ' })
      ).toEqual({ mechanism: 'GSSAPI', serviceName: 'kafka', principal: 'me@R' });
      expect(await sent({ mechanism: 'GSSAPI' })).toEqual({ mechanism: 'GSSAPI' });
      expect(
        await sent({
          mechanism: 'AWS_MSK_IAM',
          region: ' eu-west-1 ',
          credentialSource: 'profile',
          profile: ' dev ',
          allowNonAwsBrokerHosts: true,
        })
      ).toEqual({
        mechanism: 'AWS_MSK_IAM',
        region: 'eu-west-1',
        allowNonAwsBrokerHosts: true,
        credentials: { source: 'profile', profile: 'dev' },
      });
      expect(
        await sent({
          mechanism: 'AWS_MSK_IAM',
          region: 'eu-west-1',
          credentialSource: 'static',
          accessKeyId: ' AK ',
          secretAccessKey: 'SK',
          sessionToken: 'ST',
        })
      ).toEqual({
        mechanism: 'AWS_MSK_IAM',
        region: 'eu-west-1',
        credentials: {
          source: 'static',
          accessKeyId: 'AK',
          secretAccessKey: 'SK',
          sessionToken: 'ST',
        },
      });
    });
  });

  describe('produce', () => {
    const ack = { topic: 'orders', partition: 1, offset: '9', timestamp: 1 };

    it('sends a tombstone, schema-encoded key/value, headers, partition and compression', async () => {
      const { kafka } = installElectron();
      kafka.produce.mockResolvedValue({ success: true, ack });
      const id = useKafkaStore.getState().createConnection();

      await kafkaManager.produce({
        connectionId: id,
        topic: 'orders',
        key: 'k',
        keySchemaId: 3,
        value: null,
        headers: { h: 'v' },
        partition: 2,
        acks: -1,
        compression: 'gzip',
      });
      expect(kafka.produce).toHaveBeenLastCalledWith({
        connectionId: id,
        record: {
          topic: 'orders',
          key: { encoding: 'schema', schemaId: 3, data: 'k' },
          value: { encoding: 'null' },
          headers: [
            { key: { encoding: 'utf8', data: 'h' }, value: { encoding: 'utf8', data: 'v' } },
          ],
          partition: 2,
        },
        acks: -1,
        compression: 'gzip',
      });
      expect(lastMessage(id)).toMatchObject({
        direction: 'sent',
        value: '<tombstone>',
        tombstone: true,
        key: 'k',
        headers: { h: 'v' },
      });

      await kafkaManager.produce({
        connectionId: id,
        topic: 'orders',
        key: 'k',
        keySubject: { subject: 'orders-key', version: 'latest' },
        value: '{}',
        valueSubject: { subject: 'orders-value', version: 2 },
        acks: 1,
        compression: 'none',
      });
      const call = kafka.produce.mock.calls[1]![0] as {
        record: { key: unknown; value: unknown };
        compression?: string;
      };
      expect(call.record.key).toEqual({
        encoding: 'schema',
        subject: 'orders-key',
        version: 'latest',
        data: 'k',
      });
      expect(call.record.value).toEqual({
        encoding: 'schema',
        subject: 'orders-value',
        version: 2,
        data: '{}',
      });
      expect(call.compression).toBeUndefined();

      await kafkaManager.produce({
        connectionId: id,
        topic: 'orders',
        value: '{}',
        valueSchemaId: 7,
        acks: 0,
      });
      expect(
        (kafka.produce.mock.calls[2]![0] as { record: { value: unknown } }).record.value
      ).toEqual({
        encoding: 'schema',
        schemaId: 7,
        data: '{}',
      });
    });

    it('logs the failure when the ack is missing or produce fails', async () => {
      const { kafka } = installElectron();
      const id = useKafkaStore.getState().createConnection();
      kafka.produce.mockResolvedValueOnce({ success: false, error: 'not leader' });
      await expect(
        kafkaManager.produce({ connectionId: id, topic: 'orders', value: 'v', acks: 1 })
      ).resolves.toEqual({ ok: false, error: 'not leader' });
      expect(lastMessage(id)).toMatchObject({ direction: 'system', error: 'not leader' });

      kafka.produce.mockResolvedValueOnce({ success: true });
      await expect(
        kafkaManager.produce({ connectionId: id, topic: 'orders', value: 'v', acks: 1 })
      ).resolves.toEqual({ ok: false, error: 'Produce failed' });
    });
  });

  describe('subscribe', () => {
    it('reports a failed subscribe, marks the consumer errored and unbinds listeners', async () => {
      const { kafka, emit } = installElectron();
      const id = useKafkaStore.getState().createConnection();
      kafka.subscribe.mockResolvedValueOnce({ success: false, error: 'no such topic' } as never);
      await expect(
        kafkaManager.subscribe({
          connectionId: id,
          groupId: 'g',
          topics: ['t'],
          fromBeginning: false,
        })
      ).resolves.toEqual({ ok: false, error: 'no such topic' });
      expect(useKafkaStore.getState().connections[id]!.consumer.status).toBe('error');
      emit(kafkaChannel(KAFKA_CHANNEL.MESSAGE, id), { topic: 't', value: 'x' });
      expect(
        useKafkaStore.getState().connections[id]!.messages.some((m) => m.direction === 'received')
      ).toBe(false);

      kafka.subscribe.mockResolvedValueOnce({ success: false } as never);
      await expect(
        kafkaManager.subscribe({
          connectionId: id,
          groupId: 'g',
          topics: ['t'],
          fromBeginning: false,
        })
      ).resolves.toEqual({ ok: false, error: 'Subscribe failed' });
    });

    it('derives the mode from fromBeginning and forwards every configured consumer tuning knob', async () => {
      const { kafka } = installElectron();
      const id = useKafkaStore.getState().createConnection();
      useKafkaStore.getState().updateConsumer(id, {
        mode: undefined,
        membership: 'group',
        groupInstanceId: 'inst',
        groupRemoteAssignor: 'uniform',
        sessionTimeoutMs: 1,
        rebalanceTimeoutMs: 2,
        heartbeatIntervalMs: 3,
        autoCommitIntervalMs: 4,
        minBytes: 0,
        maxBytes: 5,
        maxBytesPerPartition: 6,
        maxWaitTimeMs: 0,
        highWaterMark: 7,
      } as never);
      await kafkaManager.subscribe({
        connectionId: id,
        groupId: 'g',
        topics: ['t'],
        fromBeginning: true,
        offsets: [{ topic: 't', partition: 0, offset: '1' }],
        timestamp: '2024-01-01T00:00:00Z',
      });
      const payload = (kafka.subscribe.mock.calls as unknown[][])[0]![0] as Record<string, unknown>;
      expect(payload).toMatchObject({
        groupInstanceId: 'inst',
        groupRemoteAssignor: 'uniform',
        sessionTimeoutMs: 1,
        rebalanceTimeoutMs: 2,
        heartbeatIntervalMs: 3,
        autoCommitIntervalMs: 4,
        minBytes: 0,
        maxBytes: 5,
        maxBytesPerPartition: 6,
        maxWaitTimeMs: 0,
        highWaterMark: 7,
        offsets: [{ topic: 't', partition: 0, offset: '1' }],
        timestamp: '2024-01-01T00:00:00Z',
      });
    });

    it('subscribes, then unsubscribes and disconnects with status bookkeeping', async () => {
      const { kafka } = installElectron();
      const id = useKafkaStore.getState().createConnection();
      await kafkaManager.subscribe({
        connectionId: id,
        groupId: 'g',
        topics: ['a', 'b'],
        fromBeginning: false,
        mode: 'latest',
      });
      expect(useKafkaStore.getState().connections[id]!.consumer.status).toBe('subscribed');
      expect(lastMessage(id)?.topic).toBe('a,b');

      await kafkaManager.unsubscribe(id);
      expect(kafka.unsubscribe).toHaveBeenCalledWith({ connectionId: id });
      expect(useKafkaStore.getState().connections[id]!.consumer.status).toBe('idle');
      expect(lastMessage(id)?.value).toBe('Unsubscribed');

      await kafkaManager.disconnect(id);
      expect(kafka.disconnect).toHaveBeenCalledWith({ connectionId: id });
      expect(useKafkaStore.getState().connections[id]!.status).toBe('disconnected');
    });
  });

  describe('lifecycle events', () => {
    async function connected() {
      const env = installElectron();
      const id = useKafkaStore.getState().createConnection();
      await kafkaManager.connect(useKafkaStore.getState().connections[id]!);
      return { ...env, id };
    }

    it('records close, error and consumer-closed events', async () => {
      const { emit, id } = await connected();
      emit(kafkaChannel(KAFKA_CHANNEL.ERROR, id), {});
      expect(lastMessage(id)).toMatchObject({ value: '[error] Kafka error', error: 'Kafka error' });
      emit(kafkaChannel(KAFKA_CHANNEL.ERROR, id), { scope: 'producer', message: 'oops' });
      expect(lastMessage(id)?.value).toBe('[producer] oops');
      emit(kafkaChannel(KAFKA_CHANNEL.CONSUMER_CLOSED, id), {});
      expect(useKafkaStore.getState().connections[id]!.consumer.status).toBe('idle');
      emit(kafkaChannel(KAFKA_CHANNEL.CLOSE, id), {});
      expect(useKafkaStore.getState().connections[id]!.status).toBe('disconnected');
    });

    it('records the consumer group state, defaulting to unknown', async () => {
      const { emit, id } = await connected();
      emit(kafkaChannel(KAFKA_CHANNEL.CONSUMER_STATUS, id), { state: 'Stable' });
      expect(useKafkaStore.getState().connections[id]!.consumer.groupState).toBe('Stable');
      emit(kafkaChannel(KAFKA_CHANNEL.CONSUMER_STATUS, id), {});
      expect(useKafkaStore.getState().connections[id]!.consumer.groupState).toBe('unknown');
    });

    it('ignores lag events without lag and keeps still-assigned paused partitions', async () => {
      const { emit, id } = await connected();
      emit(kafkaChannel(KAFKA_CHANNEL.CONSUMER_LAG, id), {});
      expect(useKafkaStore.getState().connections[id]!.consumer.lag).toBeUndefined();

      useKafkaStore.getState().updateConsumer(id, { pausedPartitions: ['t:0', 't:1'] } as never);
      emit(kafkaChannel(KAFKA_CHANNEL.CONSUMER_LAG, id), {
        lag: [{ topic: 't', offsets: ['5', '-1'] }],
      });
      expect(useKafkaStore.getState().connections[id]!.consumer.pausedPartitions).toEqual(['t:0']);

      useKafkaStore.getState().updateConsumer(id, { pausedPartitions: [] } as never);
      emit(kafkaChannel(KAFKA_CHANNEL.CONSUMER_LAG, id), {
        lag: [{ topic: 't', offsets: ['1'] }],
      });
      expect(useKafkaStore.getState().connections[id]!.consumer.lag).toEqual([
        { topic: 't', offsets: ['1'] },
      ]);
    });
  });
});
