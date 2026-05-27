import { create } from 'zustand';
import type { CollectionRunResult } from '@/features/collections/lib/collectionRunner';

/**
 * Recent collection / folder runs, surfaced in the Runs panel after the runner
 * dialog closes. In-memory only — runs are transient and don't need to survive
 * an app restart (mirrors `useLoadTestStore`). Capped to MAX_RUNS.
 */
interface CollectionRunState {
  runs: CollectionRunResult[];
  addRun: (run: CollectionRunResult) => void;
  clearRuns: () => void;
}

const MAX_RUNS = 20;

export const useCollectionRunStore = create<CollectionRunState>((set) => ({
  runs: [],
  addRun: (run) => set((s) => ({ runs: [run, ...s.runs].slice(0, MAX_RUNS) })),
  clearRuns: () => set({ runs: [] }),
}));
