import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KAFKA_CHANNEL, kafkaChannel } from '../../../../../electron/shared/kafka-channels';
import { kafkaManager } from '@/features/kafka/lib/kafkaManager';
import { useKafkaStore } from '@/features/kafka/store/useKafkaStore';

function installElectronMock() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const kafka = {
    connect: vi.fn(async () => ({ success: true as const })),
    produce: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    disconnect: vi.fn(),
    listTopics: vi.fn(),
    createTopic: vi.fn(),
    deleteTopic: vi.fn(),
    listGroups: vi.fn(),
    inspectTopic: vi.fn(),
    inspectGroup: vi.fn(),
    resetGroupOffsets: vi.fn(),
    deleteGroup: vi.fn(),
    on: (channel: string, callback: (...args: unknown[]) => void) => {
      const callbacks = listeners.get(channel) ?? [];
      callbacks.push(callback);
      listeners.set(channel, callbacks);
    },
    removeListener: vi.fn(),
    removeAllListeners: (channel: string) => listeners.delete(channel),
  };
  Object.defineProperty(window, 'electron', {
    value: { isElectron: true, kafka, fs: { readFile: vi.fn() } },
    configurable: true,
  });
  return {
    kafka,
    handlerCount: (channel: string) => listeners.get(channel)?.length ?? 0,
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

describe('kafkaManager (Electron path)', () => {
  beforeEach(resetStore);

  afterEach(() => {
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it('does not stack lifecycle listeners when reconnecting the same connection', async () => {
    const { handlerCount } = installElectronMock();
    const id = useKafkaStore.getState().createConnection();
    const connection = useKafkaStore.getState().connections[id]!;

    await kafkaManager.connect(connection);
    await kafkaManager.connect(connection);

    expect(handlerCount(kafkaChannel(KAFKA_CHANNEL.CLOSE, id))).toBe(1);
    expect(handlerCount(kafkaChannel(KAFKA_CHANNEL.ERROR, id))).toBe(1);
    expect(handlerCount(kafkaChannel(KAFKA_CHANNEL.CONSUMER_CLOSED, id))).toBe(1);
  });

  it('resets state and listeners when the connect IPC rejects', async () => {
    const { kafka, handlerCount } = installElectronMock();
    kafka.connect.mockRejectedValueOnce(new Error('IPC unavailable'));
    const id = useKafkaStore.getState().createConnection();

    const result = await kafkaManager.connect(useKafkaStore.getState().connections[id]!);

    expect(result).toEqual({ ok: false, error: 'IPC unavailable' });
    expect(useKafkaStore.getState().connections[id]!.status).toBe('disconnected');
    expect(handlerCount(kafkaChannel(KAFKA_CHANNEL.CLOSE, id))).toBe(0);
  });
});
