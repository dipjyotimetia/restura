import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CollectionRunResult } from '@/features/collections/lib/collectionRunner';
import { createPersistedStore } from '@/lib/shared/persistence/createPersistedStore';

/**
 * Collection / folder runs, surfaced in the Runs panel after the runner
 * dialog closes. Persisted to the encrypted Dexie `collectionRuns` table so
 * run history survives a reload — results carry statuses, timings, and
 * assertion outcomes (never response bodies), so the footprint stays small.
 * Capped to MAX_RUNS, newest first.
 */
interface CollectionRunState {
  runs: CollectionRunResult[];
  addRun: (run: CollectionRunResult) => void;
  clearRuns: () => void;
}

const MAX_RUNS = 50;

export const useCollectionRunStore = create<CollectionRunState>()(
  persist(
    (set) => ({
      runs: [],
      addRun: (run) => set((s) => ({ runs: [run, ...s.runs].slice(0, MAX_RUNS) })),
      clearRuns: () => set({ runs: [] }),
    }),
    createPersistedStore<CollectionRunState>({
      store: 'collectionRuns',
      persistName: 'collection-run-storage',
      version: 1,
      steps: [],
    })
  )
);
