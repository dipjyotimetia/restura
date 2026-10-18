import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kafkaManager } from '@/features/kafka/lib/kafkaManager';
import {
  produceWithVariables,
  resolveKafkaList,
  warnUnresolved,
} from '@/features/kafka/lib/kafkaVariables';
import { useKafkaStore } from '@/features/kafka/store/useKafkaStore';
import type { StreamingVariableScope } from '@/lib/shared/streaming/messageVariables';

const scope: StreamingVariableScope = {
  values: { host: 'broker', env: 'prod', token: 's3cr3t', quote: 'a"b' },
  secretNames: new Set(['token']),
  handleNames: new Set(),
};

describe('kafka {{var}} resolution (#984)', () => {
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

  it('resolves broker / topic lists and reports unresolved names once', () => {
    expect(resolveKafkaList(['{{host}}:9092', '{{missing}}:1', '{{missing}}:2'], scope)).toEqual({
      values: ['broker:9092', '{{missing}}:1', '{{missing}}:2'],
      unresolved: ['missing'],
    });
  });

  it('flags unresolved names on the transcript and ignores an empty list', () => {
    warnUnresolved(id, 'orders', []);
    expect(useKafkaStore.getState().connections[id]!.messages).toHaveLength(0);
    warnUnresolved(id, 'orders', ['missing']);
    expect(useKafkaStore.getState().connections[id]!.messages[0]).toMatchObject({
      direction: 'system',
      topic: 'orders',
      value: 'Unresolved variables sent literally: {{missing}}',
    });
  });

  it('resolves topic, key, value and headers; masks secrets in the transcript copy', async () => {
    await produceWithVariables(
      {
        connectionId: id,
        topic: 'orders.{{env}}',
        key: 'k-{{env}}',
        value: '{"t":"{{token}}","q":"{{quote}}"}',
        headers: { 'x-{{env}}': 'Bearer {{token}}' },
        acks: 1,
      },
      { json: true },
      scope
    );
    expect(produce).toHaveBeenCalledWith({
      connectionId: id,
      topic: 'orders.prod',
      key: 'k-prod',
      value: '{"t":"s3cr3t","q":"a\\"b"}',
      headers: { 'x-prod': 'Bearer s3cr3t' },
      acks: 1,
      display: {
        key: 'k-prod',
        value: '{"t":"••••••","q":"a\\"b"}',
        headers: { 'x-prod': 'Bearer ••••••' },
      },
    });
  });

  it('passes tombstones through and omits display when no secret was used', async () => {
    await produceWithVariables(
      { connectionId: id, topic: '{{nope}}', value: null, acks: 0 },
      {},
      scope
    );
    expect(produce).toHaveBeenCalledWith({
      connectionId: id,
      topic: '{{nope}}',
      value: null,
      acks: 0,
    });
    expect(useKafkaStore.getState().connections[id]!.messages[0]?.value).toContain('{{nope}}');
  });
});
