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
