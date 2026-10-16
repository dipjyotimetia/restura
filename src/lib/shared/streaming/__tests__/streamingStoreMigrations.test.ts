import { describe, expect, it } from 'vitest';
import { useMqttStore } from '@/features/mqtt/store/useMqttStore';
import { useSocketIOStore } from '@/features/socketio/store/useSocketIOStore';
import { useWebSocketStore } from '@/features/websocket/store/useWebSocketStore';

type Migrate = (state: unknown, version: number) => unknown;
type Migrated = { connections: Record<string, { templates: unknown[] }> };

const cases: Array<[string, Migrate, unknown]> = [
  [
    'websocket',
    useWebSocketStore.persist.getOptions().migrate as Migrate,
    { id: 'good', name: 'ok', body: '{{x}}', format: 'hex' },
  ],
  [
    'socketio',
    useSocketIOStore.persist.getOptions().migrate as Migrate,
    { id: 'good', name: 'ok', eventName: 'e', args: '[]', ack: false },
  ],
  [
    'mqtt',
    useMqttStore.persist.getOptions().migrate as Migrate,
    { id: 'good', name: 'ok', topic: 't', payload: 'p', qos: 2, retain: true },
  ],
];

describe.each(cases)('%s store v1 → v2 migration', (_name, migrate, validTemplate) => {
  it('adds templates to legacy connections and drops malformed entries', async () => {
    const out = (await migrate(
      {
        connections: {
          legacy: { id: 'legacy' },
          mixed: { id: 'mixed', templates: [validTemplate, { id: 'bad' }] },
        },
        activeConnectionId: 'legacy',
        connectionByTabId: {},
      },
      1
    )) as Migrated;
    expect(out.connections.legacy?.templates).toEqual([]);
    expect(out.connections.mixed?.templates).toEqual([validTemplate]);
  });
});

describe.each(cases)('%s store migration hardening', (_name, migrate, validTemplate) => {
  it('dedupes template ids and replaces array-valued connections', async () => {
    const out = (await migrate(
      { connections: { c: { id: 'c', templates: [validTemplate, validTemplate] } } },
      1
    )) as Migrated;
    expect(out.connections.c?.templates).toEqual([validTemplate]);
    const arr = (await migrate({ connections: [{ id: 'x' }] }, 1)) as Migrated;
    expect(arr.connections).toEqual({});
  });
});

describe('websocket frameAssertion coercion', () => {
  const migrate = useWebSocketStore.persist.getOptions().migrate as Migrate;
  it('keeps a valid config and drops a malformed one', async () => {
    const out = (await migrate(
      {
        connections: {
          ok: { id: 'ok', frameAssertion: { enabled: true, script: 's' } },
          bad: { id: 'bad', frameAssertion: { enabled: 'yes', script: 42 } },
        },
      },
      1
    )) as { connections: Record<string, { frameAssertion?: unknown }> };
    expect(out.connections.ok?.frameAssertion).toEqual({ enabled: true, script: 's' });
    expect(out.connections.bad).not.toHaveProperty('frameAssertion');
  });
});
