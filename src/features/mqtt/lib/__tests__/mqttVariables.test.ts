import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveMqttText } from '@/features/mqtt/lib/mqttVariables';
import { useMqttStore } from '@/features/mqtt/store/useMqttStore';
import type { StreamingVariableScope } from '@/lib/shared/streaming/messageVariables';

const scope: StreamingVariableScope = {
  values: { host: 'broker.local' },
  secretNames: new Set(),
  handleNames: new Set(),
};

describe('resolveMqttText (#984)', () => {
  let id: string;
  beforeEach(() => {
    id = useMqttStore.getState().createConnection();
  });
  afterEach(() => useMqttStore.getState().removeConnection(id));

  it('resolves the broker URL without touching the transcript', () => {
    expect(resolveMqttText(id, 'mqtt://{{host}}:1883', scope)).toBe('mqtt://broker.local:1883');
    expect(useMqttStore.getState().connections[id]!.messages).toHaveLength(0);
  });

  it('sends unresolved tokens literally and flags them', () => {
    expect(resolveMqttText(id, 'devices/{{site}}/#', scope)).toBe('devices/{{site}}/#');
    expect(useMqttStore.getState().connections[id]!.messages[0]).toMatchObject({
      direction: 'system',
      payload: 'Unresolved variables sent literally: {{site}}',
    });
  });
});
