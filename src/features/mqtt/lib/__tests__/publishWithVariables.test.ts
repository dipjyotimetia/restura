import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mqttManager } from '@/features/mqtt/lib/mqttManager';
import { useMqttStore } from '@/features/mqtt/store/useMqttStore';
import type { StreamingVariableScope } from '@/lib/shared/streaming/messageVariables';
import { publishWithVariables } from '../publishWithVariables';

const scope: StreamingVariableScope = {
  values: { device: 'd1', key: 'k3y', ct: 'application/json' },
  secretNames: new Set(['key']),
  handleNames: new Set(),
};

describe('publishWithVariables', () => {
  let id: string;
  let publish: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    id = useMqttStore.getState().createConnection();
    publish = vi.spyOn(mqttManager, 'publish').mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    useMqttStore.getState().removeConnection(id);
    vi.restoreAllMocks();
  });

  it('resolves topic, payload and MQTT 5 string properties', async () => {
    await publishWithVariables(
      id,
      {
        topic: 'devices/{{device}}',
        payload: '{"d":"{{device}}"}',
        qos: 1,
        retain: true,
        contentType: '{{ct}}',
        responseTopic: 'reply/{{device}}',
        userProperties: { a: 'b' },
      },
      scope
    );
    expect(publish).toHaveBeenCalledWith({
      connectionId: id,
      topic: 'devices/d1',
      payload: '{"d":"d1"}',
      qos: 1,
      retain: true,
      contentType: 'application/json',
      responseTopic: 'reply/d1',
      userProperties: { a: 'b' },
    });
  });

  it('masks secrets in the logged copy', async () => {
    await publishWithVariables(
      id,
      { topic: 't', payload: 'key={{key}}', qos: 0, retain: false },
      scope
    );
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: 'key=k3y',
        display: { topic: 't', payload: 'key=••••••' },
      })
    );
  });

  it('warns about unresolved variables', async () => {
    await publishWithVariables(
      id,
      { topic: '{{room}}', payload: '{{room}} {{x}}', qos: 0, retain: false },
      scope
    );
    const messages = useMqttStore.getState().connections[id]?.messages ?? [];
    expect(messages[0]?.payload).toBe('Unresolved variables sent literally: {{room}}, {{x}}');
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ topic: '{{room}}' }));
  });
});

describe('mqttManager.publish display override', () => {
  afterEach(() => {
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it('logs the display copy while publishing the wire payload', async () => {
    const ipcPublish = vi.fn(async (_input: unknown) => ({ success: true as const }));
    (window as unknown as { electron: unknown }).electron = {
      isElectron: true,
      mqtt: { publish: ipcPublish },
    };
    const id = useMqttStore.getState().createConnection();
    await mqttManager.publish({
      connectionId: id,
      topic: 't',
      payload: 'k3y',
      qos: 0,
      retain: false,
      display: { topic: 't', payload: '••••••' },
    });
    expect(ipcPublish).toHaveBeenCalledWith(expect.objectContaining({ payload: 'k3y' }));
    expect(ipcPublish.mock.calls[0]?.[0]).not.toHaveProperty('display');
    expect(useMqttStore.getState().connections[id]?.messages.at(-1)?.payload).toBe('••••••');
    useMqttStore.getState().removeConnection(id);
  });
});
