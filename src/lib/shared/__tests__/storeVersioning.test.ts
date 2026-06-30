// Lock-in test: every previously-unversioned persisted store now declares an
// explicit `version` and a `migrate`, so a future shape change has a hook and
// existing (version-0) blobs don't trip zustand's "couldn't be migrated" error.
// The dexie-storage adapter is mocked to a noop by tests/setup.ts, so importing
// these stores does not touch IndexedDB.
import { describe, expect, it } from 'vitest';
import { useKafkaStore } from '@/features/kafka/store/useKafkaStore';
import { useMcpStore } from '@/features/mcp/store/useMcpStore';
import { useMqttStore } from '@/features/mqtt/store/useMqttStore';
import { useSocketIOStore } from '@/features/socketio/store/useSocketIOStore';
import { useSseStore } from '@/features/sse/store/useSseStore';
import { useWebSocketStore } from '@/features/websocket/store/useWebSocketStore';
import { useGraphQLSchemaStore } from '@/store/useGraphQLSchemaStore';
import { useProtoRegistryStore } from '@/store/useProtoRegistryStore';

const STORES = {
  websocket: useWebSocketStore,
  sse: useSseStore,
  mcp: useMcpStore,
  socketio: useSocketIOStore,
  kafka: useKafkaStore,
  mqtt: useMqttStore,
  graphqlSchemas: useGraphQLSchemaStore,
  protoFiles: useProtoRegistryStore,
} as const;

describe('persisted store versioning', () => {
  for (const [label, store] of Object.entries(STORES)) {
    it(`${label} declares version >= 1 and a migrate function`, () => {
      const opts = (
        store as { persist: { getOptions: () => { version?: number; migrate?: unknown } } }
      ).persist.getOptions();
      expect(opts.version).toBeGreaterThanOrEqual(1);
      expect(typeof opts.migrate).toBe('function');
    });

    it(`${label} migrate is a passthrough (no data loss on the version-0 → v1 bump)`, () => {
      const opts = (
        store as {
          persist: { getOptions: () => { migrate?: (s: unknown, v: number) => unknown } };
        }
      ).persist.getOptions();
      const sample = { connections: { x: { id: 'x' } }, activeConnectionId: 'x' };
      expect(opts.migrate?.(sample, 0)).toBe(sample);
    });
  }
});
