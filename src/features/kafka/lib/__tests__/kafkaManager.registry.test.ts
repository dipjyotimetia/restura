import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kafkaManager } from '@/features/kafka/lib/kafkaManager';
import { KAFKA_SECRET_SENTINEL, useKafkaStore } from '@/features/kafka/store/useKafkaStore';
import { KAFKA_CHANNEL, kafkaChannel } from '../../../../../electron/shared/kafka-channels';
import { KAFKA_FLUSH_INTERVAL_MS } from '../consumedMessageBuffer';

function installElectronMock(storedSecrets: Record<string, string> = {}) {
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  const kafka = {
    connect: vi.fn(async (_config: unknown) => ({ success: true as const })),
    produce: vi.fn(async (_config: unknown) => ({
      success: true as const,
      ack: { topic: 'orders', partition: 0, offset: '1', timestamp: 1 },
    })),
    subscribe: vi.fn(async (_config: unknown) => ({ success: true as const })),
    on: (channel: string, callback: (payload: unknown) => void) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), callback]);
    },
    removeListener: vi.fn(),
    removeAllListeners: (channel: string) => listeners.delete(channel),
  };
  const store = {
    get: vi.fn(async (key: string) => storedSecrets[key] ?? null),
    set: vi.fn(async () => {}),
    delete: vi.fn(),
    clear: vi.fn(),
  };
  Object.defineProperty(window, 'electron', {
    value: { isElectron: true, kafka, store },
    configurable: true,
  });
  return {
    kafka,
    emit: (channel: string, payload: unknown) => {
      for (const listener of listeners.get(channel) ?? []) listener(payload);
    },
  };
}

describe('kafkaManager — Schema Registry', () => {
  beforeEach(() => {
    localStorage.clear();
    useKafkaStore.setState({
      connections: {},
      activeConnectionId: null,
      connectionByTabId: {},
      messageFilter: 'all',
      searchQuery: '',
    });
  });
  afterEach(() => {
    delete (window as unknown as { electron?: unknown }).electron;
  });

  const connectWithRegistry = async (registry: Record<string, unknown>) => {
    const id = useKafkaStore.getState().createConnection();
    useKafkaStore.getState().updateConnection(id, {
      registry: { url: 'https://registry.example.test', ...registry },
    });
    const result = await kafkaManager.connect(useKafkaStore.getState().connections[id]!);
    return { id, result };
  };

  it('passes a keychain-handle bearer token through by reference', async () => {
    const { kafka } = installElectronMock();
    const token = { kind: 'handle' as const, id: '7e1a6a8e-2a8b-4a43-9b5b-1f6f4f1f2c11' };
    await connectWithRegistry({ authType: 'bearer', bearerToken: token });
    expect(kafka.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        registry: { url: 'https://registry.example.test', auth: { type: 'bearer', token } },
      })
    );
  });

  it('resolves a stored (sentinel) bearer token from secure storage', async () => {
    const secrets: Record<string, string> = {};
    const { kafka } = installElectronMock(secrets);
    const id = useKafkaStore.getState().createConnection();
    secrets[`kafka:${id}:registry-token`] = 'stored-token';
    useKafkaStore.getState().updateConnection(id, {
      registry: {
        url: 'https://registry.example.test',
        authType: 'bearer',
        bearerToken: KAFKA_SECRET_SENTINEL,
      },
    });
    await kafkaManager.connect(useKafkaStore.getState().connections[id]!);
    expect(kafka.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        registry: expect.objectContaining({ auth: { type: 'bearer', token: 'stored-token' } }),
      })
    );
  });

  it('refuses to connect when bearer auth has no token', async () => {
    const { kafka } = installElectronMock();
    const { result } = await connectWithRegistry({ authType: 'bearer' });
    expect(result).toEqual({
      ok: false,
      error: 'Missing Schema Registry bearer token — re-enter it.',
    });
    expect(kafka.connect).not.toHaveBeenCalled();
  });

  it('sends subject + version schema fields for key and value', async () => {
    const { kafka } = installElectronMock();
    const { id } = await connectWithRegistry({});
    await kafkaManager.produce({
      connectionId: id,
      topic: 'orders',
      key: '"k"',
      value: '{"a":1}',
      acks: 1,
      keySubject: { subject: 'orders-key', version: 2 },
      valueSubject: { subject: 'orders-value', version: 'latest' },
    });
    expect(kafka.produce).toHaveBeenLastCalledWith(
      expect.objectContaining({
        record: expect.objectContaining({
          key: { encoding: 'schema', subject: 'orders-key', version: 2, data: '"k"' },
          value: {
            encoding: 'schema',
            subject: 'orders-value',
            version: 'latest',
            data: '{"a":1}',
          },
        }),
      })
    );
  });

  it('keeps schema labels on consumed records', async () => {
    const { emit } = installElectronMock();
    const { id } = await connectWithRegistry({});
    await kafkaManager.subscribe({
      connectionId: id,
      groupId: 'g',
      topics: ['orders'],
      fromBeginning: false,
    });
    emit(kafkaChannel(KAFKA_CHANNEL.MESSAGE, id), {
      topic: 'orders',
      partition: 0,
      offset: '3',
      key: 'k',
      keySchema: { id: 2 },
      value: '{"a":1}',
      valueSchema: { id: 1, subject: 'orders-value', version: 4 },
      timestamp: 5,
    });
    // Consumed records are batched into the store (#938).
    await new Promise((r) => setTimeout(r, KAFKA_FLUSH_INTERVAL_MS + 20));
    const received = useKafkaStore
      .getState()
      .connections[id]!.messages.find((m) => m.direction === 'received');
    expect(received).toMatchObject({
      keySchema: { id: 2 },
      valueSchema: { id: 1, subject: 'orders-value', version: 4 },
    });
  });

  it('rejects an empty inline bearer token', async () => {
    const { kafka } = installElectronMock();
    const { result } = await connectWithRegistry({
      authType: 'bearer',
      bearerToken: { kind: 'inline', value: '' },
    });
    expect(result).toMatchObject({ ok: false });
    expect(kafka.connect).not.toHaveBeenCalled();
  });

  it('resolves stored Basic passwords and omits empty Basic auth', async () => {
    const secrets: Record<string, string> = {};
    const { kafka } = installElectronMock(secrets);
    const id = useKafkaStore.getState().createConnection();
    secrets[`kafka:${id}:registry-password`] = 'stored-pw';
    useKafkaStore.getState().updateConnection(id, {
      registry: { url: 'https://r.test', auth: { password: KAFKA_SECRET_SENTINEL } },
    });
    await kafkaManager.connect(useKafkaStore.getState().connections[id]!);
    expect(kafka.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        registry: { url: 'https://r.test', auth: { password: 'stored-pw' } },
      })
    );

    useKafkaStore.getState().updateConnection(id, {
      registry: { url: 'https://r.test', auth: {} },
    });
    await kafkaManager.connect(useKafkaStore.getState().connections[id]!);
    expect(kafka.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({ registry: { url: 'https://r.test' } })
    );
  });

  it('sends a numeric key schema id when no subject is chosen', async () => {
    const { kafka } = installElectronMock();
    const { id } = await connectWithRegistry({});
    await kafkaManager.produce({
      connectionId: id,
      topic: 'orders',
      key: '"k"',
      keySchemaId: 4,
      value: 'v',
      acks: 1,
    });
    expect(kafka.produce).toHaveBeenLastCalledWith(
      expect.objectContaining({
        record: expect.objectContaining({
          key: { encoding: 'schema', schemaId: 4, data: '"k"' },
          value: { encoding: 'utf8', data: 'v' },
        }),
      })
    );
  });
});
