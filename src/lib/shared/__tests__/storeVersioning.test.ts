// Lock-in test: every persisted store that adopted the Gap #6 migration
// framework (createPersistedStore) reports an explicit `version >= 1` and a
// migrate that adopts a version-0 blob unchanged (steps: [] is a passthrough),
// so existing data survives the v0 → v1 bump and a future shape change has a
// hook. The dexie-storage adapter is mocked to a noop by tests/setup.ts, so
// importing these stores does not touch IndexedDB.
import { describe, expect, it } from 'vitest';
import { useKafkaStore } from '@/features/kafka/store/useKafkaStore';
import { useMcpStore } from '@/features/mcp/store/useMcpStore';
import { useMqttStore } from '@/features/mqtt/store/useMqttStore';
import { useSocketIOStore } from '@/features/socketio/store/useSocketIOStore';
import { useSseStore } from '@/features/sse/store/useSseStore';
import { useWebSocketStore } from '@/features/websocket/store/useWebSocketStore';
import { useCollectionRunStore } from '@/store/useCollectionRunStore';
import { useConsoleStore } from '@/store/useConsoleStore';
import { useGlobalsStore } from '@/store/useGlobalsStore';
import { useGraphQLSchemaStore } from '@/store/useGraphQLSchemaStore';
import { useProtoRegistryStore } from '@/store/useProtoRegistryStore';

type PersistedStore = {
  persist: {
    getOptions: () => {
      version?: number;
      migrate?: (s: unknown, v: number) => unknown | Promise<unknown>;
    };
  };
};

const STORES: Record<string, PersistedStore> = {
  websocket: useWebSocketStore as unknown as PersistedStore,
  sse: useSseStore as unknown as PersistedStore,
  mcp: useMcpStore as unknown as PersistedStore,
  socketio: useSocketIOStore as unknown as PersistedStore,
  kafka: useKafkaStore as unknown as PersistedStore,
  mqtt: useMqttStore as unknown as PersistedStore,
  graphqlSchemas: useGraphQLSchemaStore as unknown as PersistedStore,
  protoFiles: useProtoRegistryStore as unknown as PersistedStore,
  console: useConsoleStore as unknown as PersistedStore,
  collectionRuns: useCollectionRunStore as unknown as PersistedStore,
  globals: useGlobalsStore as unknown as PersistedStore,
};

describe('framework-adopted store versioning', () => {
  for (const [label, store] of Object.entries(STORES)) {
    it(`${label} declares version >= 1 and a migrate function`, () => {
      const opts = store.persist.getOptions();
      expect(opts.version).toBeGreaterThanOrEqual(1);
      expect(typeof opts.migrate).toBe('function');
    });

    it(`${label} migrate adopts a version-0 blob unchanged (no data loss on the bump)`, async () => {
      const opts = store.persist.getOptions();
      const sample = { connections: { x: { id: 'x' } }, activeConnectionId: 'x' };
      // The factory migrate is async (runMigrations + telemetry); with steps: []
      // it returns the persisted state unchanged.
      await expect(Promise.resolve(opts.migrate?.(sample, 0))).resolves.toEqual(sample);
    });
  }
});
