import { v4 as uuidv4 } from 'uuid';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { newestFirst } from '../lib/newestFirst';
import type { EvalCellResult, EvalRun, EvalRunStatus } from '../types';
import { debouncedStorage } from '@/lib/shared/debouncedStorage';
import { dexieStorageAdapters } from '@/lib/shared/dexie-storage';
import { EvalRunStateSchema } from '@/lib/shared/store-validators';

/** Keep run history bounded — evals can be large and we re-encrypt the lot on write. */
const MAX_RUNS = 50;

interface PersistedEvalRunState {
  runs: Record<string, EvalRun>;
}

interface EvalRunState extends PersistedEvalRunState {
  startRun: (init: {
    evalConfigId: string;
    configName: string;
    totalCells: number;
    datasetId?: string;
    datasetName?: string;
    modelLabels?: Record<string, string>;
  }) => string;
  /** Single-cell convenience over addCells. */
  addCell: (runId: string, cell: EvalCellResult) => void;
  /** Append a batch in one update — one array copy + one notification. */
  addCells: (runId: string, cells: EvalCellResult[]) => void;
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
          ...(init.datasetId ? { datasetId: init.datasetId } : {}),
          ...(init.datasetName ? { datasetName: init.datasetName } : {}),
          ...(init.modelLabels ? { modelLabels: init.modelLabels } : {}),
          startedAt: Date.now(),
          status: 'running',
          cells: [],
          totalCells: init.totalCells,
        };
        set((s) => ({ runs: prune({ ...s.runs, [id]: run }) }));
        return id;
      },
      addCell: (runId, cell) => get().addCells(runId, [cell]),
      addCells: (runId, cells) =>
        set((s) => {
          const run = s.runs[runId];
          if (!run || cells.length === 0) return {};
          return { runs: { ...s.runs, [runId]: { ...run, cells: [...run.cells, ...cells] } } };
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
      listRuns: () => newestFirst(get().runs),
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
