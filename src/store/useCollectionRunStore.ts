import { evidenceBytes, RESPONSE_EVIDENCE_LIMITS } from '@shared/collection-run/evidence';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CollectionRunResult } from '@/features/collections/lib/collectionRunner';
import { createPersistedStore } from '@/lib/shared/persistence/createPersistedStore';

/**
 * Collection / folder runs, surfaced in the Runs panel after the runner
 * dialog closes. Persisted to the encrypted Dexie `collectionRuns` table so
 * run history survives a reload. Evidence is already sanitized and bounded by
 * the runner; this store is the second, deterministic quota boundary.
 */
interface CollectionRunState {
  runs: CollectionRunResult[];
  addRun: (run: CollectionRunResult) => void;
  removeRun: (runId: string) => void;
  clearRuns: () => void;
}

const MAX_RUNS = 50;

function markUnavailable<T extends CollectionRunResult>(run: T): T {
  return {
    ...run,
    requests: run.requests.map((request) =>
      request.evidence
        ? {
            ...request,
            evidence: {
              ...request.evidence,
              hash: undefined,
              excerpt: undefined,
              truncated: false,
              unavailable: true,
            },
          }
        : request
    ),
  };
}

function runEvidenceBytes(run: CollectionRunResult): number {
  return run.requests.reduce((total, request) => total + evidenceBytes(request.evidence), 0);
}

/** Quota policy: retain completed metadata, evict evidence from oldest runs first. */
export function pruneCollectionRuns(runs: CollectionRunResult[]): CollectionRunResult[] {
  let retained = runs
    .slice(0, MAX_RUNS)
    .map((run) =>
      runEvidenceBytes(run) > RESPONSE_EVIDENCE_LIMITS.perRunBytes ? markUnavailable(run) : run
    );
  let total = retained.reduce((sum, run) => sum + runEvidenceBytes(run), 0);
  for (
    let index = retained.length - 1;
    index >= 0 && total > RESPONSE_EVIDENCE_LIMITS.totalBytes;
    index--
  ) {
    const run = retained[index]!;
    const bytes = runEvidenceBytes(run);
    if (bytes === 0) continue;
    retained[index] = markUnavailable(run);
    total -= bytes;
  }
  return retained;
}

export const useCollectionRunStore = create<CollectionRunState>()(
  persist(
    (set) => ({
      runs: [],
      addRun: (run) => set((s) => ({ runs: pruneCollectionRuns([run, ...s.runs]) })),
      removeRun: (runId) => set((s) => ({ runs: s.runs.filter((run) => run.id !== runId) })),
      clearRuns: () => set({ runs: [] }),
    }),
    createPersistedStore<CollectionRunState>({
      store: 'collectionRuns',
      persistName: 'collection-run-storage',
      version: 2,
      steps: [
        {
          name: 'add-evidence-configuration-defaults',
          fromVersion: 1,
          apply: (state) => {
            const value = state as { runs?: CollectionRunResult[] };
            return {
              state: {
                ...value,
                runs: Array.isArray(value.runs) ? pruneCollectionRuns(value.runs) : [],
              },
            };
          },
        },
      ],
    })
  )
);
