import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { v4 as uuidv4 } from 'uuid';
import { dexieStorageAdapters } from '@/lib/shared/dexie-storage';
import { debouncedStorage } from '@/lib/shared/debouncedStorage';
import { EvalRunStateSchema } from '@/lib/shared/store-validators';
import type { EvalCellResult, EvalRun, EvalRunStatus } from '../types';

/** Keep run history bounded — evals can be large and we re-encrypt the lot on write. */
const MAX_RUNS = 50;

interface PersistedEvalRunState {
  runs: Record<string, EvalRun>;
}

interface EvalRunState extends PersistedEvalRunState {
  startRun: (init: { evalConfigId: string; configName: string; totalCells: number }) => string;
  addCell: (runId: string, cell: EvalCellResult) => void;
  finishRun: (runId: string, status: EvalRunStatus) => void;
  deleteRun: (id: string) => void;
  /** Runs sorted newest-first. */
  listRuns: () => EvalRun[];
}

const DEFAULT_STATE: PersistedEvalRunState = { runs: {} };

function prune(runs: Record<string, EvalRun>): Record<string, EvalRun> {
  const ids = Object.values(runs)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(MAX_RUNS)
    .map((r) => r.id);
  if (ids.length === 0) return runs;
  const next = { ...runs };
  for (const id of ids) delete next[id];
  return next;
}

export const useEvalRunStore = create<EvalRunState>()(
  persist(
    (set, get) => ({
      ...DEFAULT_STATE,

      startRun: (init) => {
        const id = uuidv4();
        const run: EvalRun = {
          id,
          evalConfigId: init.evalConfigId,
          configName: init.configName,
          startedAt: Date.now(),
          status: 'running',
          cells: [],
          totalCells: init.totalCells,
        };
        set((s) => ({ runs: prune({ ...s.runs, [id]: run }) }));
        return id;
      },
      addCell: (runId, cell) =>
        set((s) => {
          const run = s.runs[runId];
          if (!run) return {};
          return { runs: { ...s.runs, [runId]: { ...run, cells: [...run.cells, cell] } } };
        }),
      finishRun: (runId, status) =>
        set((s) => {
          const run = s.runs[runId];
          if (!run) return {};
          return {
            runs: { ...s.runs, [runId]: { ...run, status, finishedAt: Date.now() } },
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
      name: 'eval-runs-store',
      // A run appends a cell per completed (case × model). Debounce so a large
      // eval doesn't re-encrypt the whole table on every cell (O(n²) writes).
      storage: debouncedStorage(dexieStorageAdapters.evalRuns(), 400, 2000),
      version: 1,
      partialize: (state) => ({ runs: state.runs }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const parsed = EvalRunStateSchema.safeParse(state);
        if (!parsed.success) {
          useEvalRunStore.setState({ ...DEFAULT_STATE });
          return;
        }
        // A run still 'running' at hydrate time was interrupted by a reload.
        const runs = { ...state.runs };
        let touched = false;
        for (const [id, run] of Object.entries(runs)) {
          if (run.status === 'running') {
            runs[id] = { ...run, status: 'error', finishedAt: Date.now() };
            touched = true;
          }
        }
        if (touched) useEvalRunStore.setState({ runs });
      },
    }
  )
);
