/**
 * STATUS: available, not yet adopted. This is the intended home for versioned
 * store migrations, but the live stores still hand-roll their `persist` options
 * (each declares its own `version`/`migrate`/`storage`). Adopt it for NEW stores,
 * and migrate existing ones onto it deliberately — note two gaps to close first:
 *   1. storage selection is fixed to `dexieStorageAdapters[descriptor.store]()`,
 *      so it can't yet express the `withLegacyLocalStorageFallback` wrapper that
 *      the graphql/proto stores need;
 *   2. the real value (quarantine + schema validation) only kicks in with a
 *      per-store Zod `schema` + `steps`, which must be written carefully to
 *      avoid quarantining valid data.
 *
 * Factory that turns a `MigrationDescriptor` into a fully-wired zustand
 * `PersistOptions` object (Gap #6). Centralises:
 *   - storage adapter selection (via `dexieStorageAdapters[descriptor.store]`)
 *   - migrate (via `runMigrations` + optional quarantine)
 *   - onRehydrateStorage error logging
 *   - migration telemetry emit
 *
 * Stores consume it via:
 *   create(persist((set,get) => ({ ... }), createPersistedStore<State>(descriptor)))
 */

import type { PersistOptions, PersistStorage } from 'zustand/middleware';
import { quarantineState } from './quarantine';
import { runMigrations } from './runMigrations';
import { migrationTelemetry } from './telemetry';
import type { MigrationDescriptor } from './types';
import { dexieStorageAdapters } from '@/lib/shared/dexie-storage';

export function createPersistedStore<T>(descriptor: MigrationDescriptor<T>): PersistOptions<T> {
  // The adapter is a generic encrypted-blob store typed `PersistStorage<unknown>`;
  // each descriptor declares the exact T it persists, so narrowing here is
  // sound — descriptor.store selects the table whose typed slot matches T.
  const storage = dexieStorageAdapters[descriptor.store]() as unknown as PersistStorage<T>;
  const opts: PersistOptions<T> = {
    name: descriptor.persistName,
    version: descriptor.version,
    storage,
    migrate: async (persistedState: unknown, version: number) => {
      const outcome = runMigrations(descriptor, persistedState, version);
      migrationTelemetry.emit(outcome);
      if (outcome.kind === 'quarantined') {
        await quarantineState(outcome.quarantineKey, persistedState, outcome.reason);
        // Returning undefined → zustand uses the store's initialState.
        return undefined as unknown as T;
      }
      if (outcome.kind === 'noop') {
        return persistedState as T;
      }
      return outcome.state as T;
    },
    onRehydrateStorage: () => (_state, error) => {
      if (error) {
        console.error(`[persist:${descriptor.store}] rehydrate failed:`, error);
      }
    },
  };
  if (descriptor.partialize) {
    // zustand over-narrows partialize to `T → T` in its type; at runtime it
    // accepts `T → Partial<T>` (the persist middleware merges with initial
    // state). Cast lets descriptors declare the honest `Partial<T>` shape.
    opts.partialize = descriptor.partialize as unknown as (state: T) => T;
  }
  return opts;
}
