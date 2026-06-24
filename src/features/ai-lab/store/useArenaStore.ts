import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { v4 as uuidv4 } from 'uuid';
import { dexieStorageAdapters } from '@/lib/shared/dexie-storage';
import { ArenaStateSchema } from '@/lib/shared/store-validators';
import type { ArenaMatch, ArenaRun, EvalRunStatus } from '../types';

/** Bound arena history like eval runs — the whole table is re-encrypted on write. */
const MAX_RUNS = 30;

interface PersistedArenaState {
  runs: Record<string, ArenaRun>;
}

interface ArenaState extends PersistedArenaState {
  startRun: (init: {
    datasetId: string;
    datasetName: string;
    modelKeys: string[];
    modelLabels: Record<string, string>;
  }) => string;
  finishRun: (runId: string, matches: ArenaMatch[], status: EvalRunStatus) => void;
  deleteRun: (id: string) => void;
  listRuns: () => ArenaRun[];
}

const DEFAULT_STATE: PersistedArenaState = { runs: {} };

function prune(runs: Record<string, ArenaRun>): Record<string, ArenaRun> {
  const ids = Object.values(runs)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(MAX_RUNS)
    .map((r) => r.id);
  if (ids.length === 0) return runs;
  const next = { ...runs };
  for (const id of ids) delete next[id];
  return next;
}

export const useArenaStore = create<ArenaState>()(
  persist(
    (set, get) => ({
      ...DEFAULT_STATE,

      startRun: (init) => {
        const id = uuidv4();
        const run: ArenaRun = {
          id,
          datasetId: init.datasetId,
          datasetName: init.datasetName,
          modelKeys: init.modelKeys,
          modelLabels: init.modelLabels,
          matches: [],
          startedAt: Date.now(),
          status: 'running',
        };
        set((s) => ({ runs: prune({ ...s.runs, [id]: run }) }));
        return id;
      },
      finishRun: (runId, matches, status) =>
        set((s) => {
          const run = s.runs[runId];
          if (!run) return {};
          return {
            runs: { ...s.runs, [runId]: { ...run, matches, status, finishedAt: Date.now() } },
          };
        }),
      deleteRun: (id) =>
        set((s) => {
          const next = { ...s.runs };
          delete next[id];
          return { runs: next };
        }),
      listRuns: () => Object.values(get().runs).sort((a, b) => b.startedAt - a.startedAt),
    }),
    {
      name: 'arena-runs-store',
      storage: dexieStorageAdapters.arenaRuns(),
      version: 1,
      partialize: (state) => ({ runs: state.runs }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const parsed = ArenaStateSchema.safeParse(state);
        if (!parsed.success) {
          useArenaStore.setState({ ...DEFAULT_STATE });
          return;
        }
        // A run still 'running' at hydrate was interrupted by a reload.
        const runs = { ...state.runs };
        let touched = false;
        for (const [id, run] of Object.entries(runs)) {
          if (run.status === 'running') {
            runs[id] = { ...run, status: 'error', finishedAt: Date.now() };
            touched = true;
          }
        }
        if (touched) useArenaStore.setState({ runs });
      },
    }
  )
);
