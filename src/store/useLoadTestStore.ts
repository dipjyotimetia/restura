import { create } from 'zustand';
import type { LoadStats } from '@/lib/shared/loadStats';
import type { HttpRequest } from '@/types';

/**
 * Recent load-test runs, so results are observable in the Runs panel after the
 * dialog closes (they used to vanish with the modal). In-memory only — runs are
 * transient and don't need to survive an app restart. Capped to MAX_RUNS.
 */
export interface LoadTestRun {
  id: string;
  method: string;
  url: string;
  requestName: string;
  /** Snapshot of the request so the run can be re-launched from the panel. */
  request: HttpRequest;
  stats: LoadStats;
  /** Throughput over all completed requests (not just successes). */
  rps: number;
  completedAt: number;
}

interface LoadTestState {
  runs: LoadTestRun[];
  addRun: (run: LoadTestRun) => void;
  clearRuns: () => void;
}

const MAX_RUNS = 20;

export const useLoadTestStore = create<LoadTestState>((set) => ({
  runs: [],
  addRun: (run) => set((s) => ({ runs: [run, ...s.runs].slice(0, MAX_RUNS) })),
  clearRuns: () => set({ runs: [] }),
}));
