import { describe, expect, it } from 'vitest';
import { mqttManager, mqttSecretKey } from '@/features/mqtt/lib/mqttManager';
import { useMqttStore } from '@/features/mqtt/store/useMqttStore';

// jsdom has no `window.electron`, so isElectron() is false here — exercising
// the desktop-only guard rails without an Electron harness.
describe('mqttManager (web / non-Electron)', () => {
  it('connect returns the desktop-only error and leaves status disconnected', async () => {
    const id = useMqttStore.getState().createConnection();
    const conn = useMqttStore.getState().connections[id]!;
    const result = await mqttManager.connect(conn);
    expect(result).toEqual({ ok: false, error: expect.stringContaining('desktop app') });
    expect(useMqttStore.getState().connections[id]!.status).toBe('disconnected');
  });

  it('publish and subscribe return desktop-only errors', async () => {
    const id = useMqttStore.getState().createConnection();
    const pub = await mqttManager.publish({
      connectionId: id,
      topic: 't',
      payload: 'x',
      qos: 0,
      retain: false,
    });
    expect(pub).toEqual({ ok: false, error: expect.stringContaining('desktop-only') });

    const sub = await mqttManager.subscribe({ connectionId: id, topicFilter: 'a/#', qos: 0 });
    expect(sub).toEqual({ ok: false, error: expect.stringContaining('desktop-only') });
  });

  it('mqttSecretKey routes through a password-sensitive key shape', () => {
    expect(mqttSecretKey('conn-1', 'password')).toBe('mqtt:conn-1:password');
    expect(mqttSecretKey('conn-1', 'tls-passphrase')).toBe('mqtt:conn-1:tls-passphrase');
  });
});
