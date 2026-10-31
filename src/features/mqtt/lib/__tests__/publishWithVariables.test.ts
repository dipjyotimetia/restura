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

describe('publishWithVariables — options and error paths', () => {
  const scope: StreamingVariableScope = {
    values: { ct: 'text/x', k: 'secret' },
    secretNames: new Set(['k']),
    handleNames: new Set(),
  };
  const input = { topic: 't', payload: 'p', qos: 0 as const, retain: false };
  let id: string;
  let publish: ReturnType<typeof vi.spyOn>;
  let request: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    id = useMqttStore.getState().createConnection();
    publish = vi.spyOn(mqttManager, 'publish').mockResolvedValue({ ok: true });
    request = vi.spyOn(mqttManager, 'request').mockResolvedValue({ success: true });
  });
  afterEach(() => {
    useMqttStore.getState().removeConnection(id);
    vi.restoreAllMocks();
  });

  it('logs an error and does not publish when the payload does not match its format', async () => {
    const res = await publishWithVariables(id, { ...input, payload: '{bad' }, scope, {
      format: 'json',
    });
    expect(res.ok).toBe(false);
    expect(publish).not.toHaveBeenCalled();
    const last = useMqttStore.getState().connections[id]!.messages.at(-1)!;
    expect(last.error).toMatch(/not valid JSON/);
    expect(last.topic).toBe('t');

    const hex = await publishWithVariables(id, { ...input, payload: 'zz' }, scope, {
      format: 'hex',
    });
    expect(hex).toEqual({ ok: false, error: 'Hex payload must be an even number of hex digits' });
  });

  it('sends hex payloads as base64 with a base64 payload encoding', async () => {
    await publishWithVariables(id, { ...input, payload: 'de ad' }, scope, { format: 'hex' });
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ payload: '3q0=', payloadEncoding: 'base64' })
    );
  });

  it('forwards composer-only options: expiry, format indicator, alias and correlation data', async () => {
    await publishWithVariables(id, input, scope, {
      messageExpiryInterval: 0,
      payloadFormatIndicator: false,
      topicAlias: 3,
      correlationData: 'abc',
    });
    expect(publish).toHaveBeenCalledWith({
      connectionId: id,
      topic: 't',
      payload: 'p',
      qos: 0,
      retain: false,
      topicAlias: 3,
      messageExpiryInterval: 0,
      payloadFormatIndicator: false,
      correlationData: 'abc',
      correlationDataEncoding: 'utf8',
    });
  });

  it('omits blank content type / response topic and absent options', async () => {
    await publishWithVariables(id, { ...input, contentType: '', responseTopic: '' }, scope);
    const arg = publish.mock.calls[0]?.[0] as Record<string, unknown>;
    for (const key of [
      'contentType',
      'responseTopic',
      'userProperties',
      'topicAlias',
      'correlationData',
      'messageExpiryInterval',
      'display',
    ]) {
      expect(arg).not.toHaveProperty(key);
    }
  });

  it('shares the unresolved warning across topic, content type and response topic once', async () => {
    await publishWithVariables(
      id,
      {
        ...input,
        topic: '{{a}}',
        contentType: '{{a}}/{{b}}',
        responseTopic: '{{c}}',
      },
      scope
    );
    expect(useMqttStore.getState().connections[id]!.messages[0]?.payload).toBe(
      'Unresolved variables sent literally: {{a}}, {{b}}, {{c}}'
    );
  });

  it('masks a secret used in the topic', async () => {
    await publishWithVariables(id, { ...input, topic: 'dev/{{k}}' }, scope);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: 'dev/secret',
        display: { topic: 'dev/••••••', payload: 'p' },
      })
    );
  });

  it('routes through request() in request mode with extras and display', async () => {
    const res = await publishWithVariables(
      id,
      { ...input, payload: '{{k}}', contentType: '{{ct}}' },
      scope,
      { request: { requestId: 'r1', timeoutMs: 500 }, correlationData: 'c1' }
    );
    expect(res).toEqual({ ok: true });
    expect(publish).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: id,
        requestId: 'r1',
        timeoutMs: 500,
        payload: 'secret',
        contentType: 'text/x',
        correlationData: 'c1',
        display: { topic: 't', payload: '••••••' },
      })
    );
  });

  it('reports request failures, defaulting the message', async () => {
    request.mockResolvedValueOnce({ success: false, error: 'timed out' });
    expect(
      await publishWithVariables(id, input, scope, { request: { requestId: 'r', timeoutMs: 1 } })
    ).toEqual({ ok: false, error: 'timed out' });
    request.mockResolvedValueOnce({ success: false });
    expect(
      await publishWithVariables(id, input, scope, { request: { requestId: 'r', timeoutMs: 1 } })
    ).toEqual({ ok: false, error: 'Request failed' });
  });

  it('falls back to the active variable scope when none is passed', async () => {
    await publishWithVariables(id, { ...input, payload: 'plain' });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ payload: 'plain' }));
  });

  it('stringifies a non-Error thrown while encoding', async () => {
    const spy = vi.spyOn(JSON, 'parse').mockImplementation(() => {
      throw 'raw failure';
    });
    try {
      const res = await publishWithVariables(id, input, scope, { format: 'json' });
      expect(res.ok).toBe(false);
      expect(useMqttStore.getState().connections[id]!.messages.at(-1)?.error).toContain(
        'raw failure'
      );
    } finally {
      spy.mockRestore();
    }
  });
});
