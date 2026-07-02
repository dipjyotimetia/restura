/**
 * Factory that turns a `MigrationDescriptor` into a fully-wired zustand
 * `PersistOptions` object (Gap #6). Centralises:
 *   - storage adapter selection (via `dexieStorageAdapters[descriptor.store]`)
 *   - migrate (via `runMigrations` + optional quarantine)
 *   - onRehydrateStorage error logging
 *   - migration telemetry emit
 *
 * Stores consume it via:
 *   create(persist((set,get) => ({ ... }), createPersistedStore<State>(descriptor)))
 *
 * Adopted by the version-1 stores (connection protocols, graphql/proto, console,
 * collectionRuns, globals). The multi-version stores (collections, history,
 * settings, request, environment, workflow, cookies) still hand-roll `persist`;
 * adopting them requires decomposing their monolithic `migrate` into
 * version-keyed `steps`, which is data-sensitive and done deliberately per store.
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
    onRehydrateStorage: () => (state, error) => {
      if (error) {
        console.error(`[persist:${descriptor.store}] rehydrate failed:`, error);
      }
      descriptor.onRehydrate?.(state, error);
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
