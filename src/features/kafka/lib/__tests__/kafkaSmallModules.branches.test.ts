import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConsumedMessageBuffer,
  type KafkaConsumedPayload,
  toReceivedMessage,
} from '@/features/kafka/lib/consumedMessageBuffer';
import { kafkaManager } from '@/features/kafka/lib/kafkaManager';
import { produceWithVariables } from '@/features/kafka/lib/kafkaVariables';
import {
  pauseKafkaPartitions,
  resumeKafkaPartitions,
  seekKafkaPartition,
} from '@/features/kafka/lib/partitionControl';
import { useKafkaStore } from '@/features/kafka/store/useKafkaStore';
import type { StreamingVariableScope } from '@/lib/shared/streaming/messageVariables';

function setElectron(kafka: Record<string, unknown> | null): void {
  if (kafka === null) {
    delete (window as unknown as { electron?: unknown }).electron;
    return;
  }
  Object.defineProperty(window, 'electron', { value: { kafka }, configurable: true });
}

afterEach(() => setElectron(null));

describe('partitionControl', () => {
  const parts = [{ topic: 't', partition: 0 }];

  it('reports an unavailable bridge for every operation', async () => {
    const unavailable = { ok: false, error: 'Electron API unavailable.' };
    await expect(pauseKafkaPartitions('c', parts)).resolves.toEqual(unavailable);
    await expect(resumeKafkaPartitions('c', parts)).resolves.toEqual(unavailable);
    await expect(
      seekKafkaPartition('c', parts[0]!, { type: 'beginning' } as never)
    ).resolves.toEqual(unavailable);
  });

  it('returns the paused set, defaulting to empty when main omits it', async () => {
    const pausePartitions = vi
      .fn()
      .mockResolvedValueOnce({ success: true, pausedPartitions: parts })
      .mockResolvedValueOnce({ success: true });
    setElectron({ pausePartitions });
    await expect(pauseKafkaPartitions('c', parts)).resolves.toEqual({ ok: true, paused: parts });
    await expect(pauseKafkaPartitions('c', parts)).resolves.toEqual({ ok: true, paused: [] });
  });

  it('uses main error text, a per-operation fallback, or the thrown message', async () => {
    const pausePartitions = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'not assigned' })
      .mockResolvedValueOnce({ success: false })
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockRejectedValueOnce('weird');
    setElectron({ pausePartitions });
    await expect(pauseKafkaPartitions('c', parts)).resolves.toEqual({
      ok: false,
      error: 'not assigned',
    });
    await expect(pauseKafkaPartitions('c', parts)).resolves.toEqual({
      ok: false,
      error: 'Pause partition failed',
    });
    await expect(pauseKafkaPartitions('c', parts)).resolves.toEqual({
      ok: false,
      error: 'rate limited',
    });
    await expect(pauseKafkaPartitions('c', parts)).resolves.toEqual({
      ok: false,
      error: 'Pause partition failed',
    });
  });

  it('resumes partitions with its own fallback message', async () => {
    const resumePartitions = vi
      .fn()
      .mockResolvedValueOnce({ success: true, pausedPartitions: [] })
      .mockResolvedValueOnce({ success: false });
    setElectron({ resumePartitions });
    await expect(resumeKafkaPartitions('c', parts)).resolves.toEqual({ ok: true, paused: [] });
    await expect(resumeKafkaPartitions('c', parts)).resolves.toEqual({
      ok: false,
      error: 'Resume partition failed',
    });
  });

  it('seeks and maps every failure shape', async () => {
    const seekConsumer = vi
      .fn()
      .mockResolvedValueOnce({ success: true, offset: '42' })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'out of range' })
      .mockRejectedValueOnce(new Error('ipc down'))
      .mockRejectedValueOnce(null);
    setElectron({ seekConsumer });
    const target = { type: 'offset', offset: '42' } as never;
    await expect(seekKafkaPartition('c', parts[0]!, target)).resolves.toEqual({
      ok: true,
      offset: '42',
    });
    expect(seekConsumer).toHaveBeenCalledWith({
      connectionId: 'c',
      topic: 't',
      partition: 0,
      target,
    });
    await expect(seekKafkaPartition('c', parts[0]!, target)).resolves.toEqual({
      ok: false,
      error: 'Seek failed',
    });
    await expect(seekKafkaPartition('c', parts[0]!, target)).resolves.toEqual({
      ok: false,
      error: 'out of range',
    });
    await expect(seekKafkaPartition('c', parts[0]!, target)).resolves.toEqual({
      ok: false,
      error: 'ipc down',
    });
    await expect(seekKafkaPartition('c', parts[0]!, target)).resolves.toEqual({
      ok: false,
      error: 'Seek failed',
    });
  });
});

describe('consumedMessageBuffer', () => {
  const payload = (over: Partial<KafkaConsumedPayload> = {}): KafkaConsumedPayload => ({
    topic: 't',
    partition: 1,
    offset: '9',
    value: 'v',
    timestamp: 5,
    ...over,
  });

  it('keeps only the fields the record actually carries', () => {
    expect(toReceivedMessage(payload())).toEqual({
      direction: 'received',
      topic: 't',
      partition: 1,
      offset: '9',
      value: 'v',
      timestamp: 5,
    });
  });

  it('carries key, encodings, schemas, headers and commit token through', () => {
    const keySchema = { id: 1 } as never;
    const valueSchema = { id: 2 } as never;
    expect(
      toReceivedMessage(
        payload({
          key: '',
          keyEncoding: 'base64',
          keySchema,
          valueEncoding: 'base64',
          valueSchema,
          headers: { h: '1' },
          binaryHeaders: [{ key: 'b', value: 'AA==' }],
          commitToken: 'tok',
        })
      )
    ).toMatchObject({
      key: '',
      keyEncoding: 'base64',
      keySchema,
      valueEncoding: 'base64',
      valueSchema,
      headers: { h: '1' },
      binaryHeaders: [{ key: 'b', value: 'AA==' }],
      commitToken: 'tok',
    });
  });

  it('replaces the value of a tombstone and flags it', () => {
    expect(toReceivedMessage(payload({ tombstone: true, value: 'ignored' }))).toMatchObject({
      value: '<tombstone>',
      tombstone: true,
    });
  });

  it('flush on an empty or unknown connection never calls the sink; discard cancels the timer', () => {
    vi.useFakeTimers();
    try {
      const sink = vi.fn();
      const buffer = new ConsumedMessageBuffer(sink, 50, 2);
      buffer.flush('nope');
      buffer.push('a', toReceivedMessage(payload({ offset: '1' })));
      buffer.push('a', toReceivedMessage(payload({ offset: '2' })));
      buffer.push('a', toReceivedMessage(payload({ offset: '3' })));
      buffer.discard('a');
      vi.advanceTimersByTime(100);
      expect(sink).not.toHaveBeenCalled();
      buffer.discard('never-seen');

      buffer.push('b', toReceivedMessage(payload({ offset: '1' })));
      buffer.push('b', toReceivedMessage(payload({ offset: '2' })));
      buffer.push('b', toReceivedMessage(payload({ offset: '3' })));
      vi.advanceTimersByTime(60);
      expect(sink).toHaveBeenCalledTimes(1);
      expect(sink.mock.calls[0]![1].map((m: { offset: string }) => m.offset)).toEqual(['2', '3']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('produceWithVariables display masking', () => {
  const scope: StreamingVariableScope = {
    values: { token: 's3cr3t', env: 'prod' },
    secretNames: new Set(['token']),
    handleNames: new Set(),
  };
  let id: string;
  let produce: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    id = useKafkaStore.getState().createConnection();
    produce = vi.spyOn(kafkaManager, 'produce').mockResolvedValue({
      ok: true,
      ack: { topic: 't', partition: 0, offset: '0', timestamp: 0 },
    });
  });
  afterEach(() => {
    useKafkaStore.getState().removeConnection(id);
    vi.restoreAllMocks();
  });

  it('masks a secret used only in the topic without inventing key/value/header display copies', async () => {
    await produceWithVariables(
      { connectionId: id, topic: 'orders.{{token}}', value: null, acks: 1 },
      {},
      scope
    );
    const sent = produce.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.topic).toBe('orders.s3cr3t');
    expect(sent.value).toBeNull();
    expect(sent).not.toHaveProperty('key');
    expect(sent.display).toEqual({});
  });

  it('masks a secret used only in the value and leaves out key and headers', async () => {
    await produceWithVariables(
      { connectionId: id, topic: 't', value: 'x={{token}}', acks: 1 },
      {},
      scope
    );
    const sent = produce.mock.calls[0]![0] as { display: Record<string, unknown> };
    expect(Object.keys(sent.display)).toEqual(['value']);
    expect(String(sent.display.value)).not.toContain('s3cr3t');
  });

  it('adds display copies of the key and headers when a secret is used', async () => {
    await produceWithVariables(
      {
        connectionId: id,
        topic: 't',
        key: 'k-{{env}}',
        value: 'v',
        headers: { a: '{{token}}' },
        acks: 1,
      },
      {},
      scope
    );
    const sent = produce.mock.calls[0]![0] as {
      display: { key?: string; headers?: Record<string, string> };
    };
    expect(sent.display.key).toBe('k-prod');
    expect(JSON.stringify(sent.display.headers)).not.toContain('s3cr3t');
  });
});
