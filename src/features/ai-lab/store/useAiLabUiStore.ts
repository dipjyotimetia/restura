import { v4 as uuidv4 } from 'uuid';
import { create } from 'zustand';
import type { ScorerConfig } from '../types';

/**
 * Session-scoped AI Lab UI state. Deliberately NOT persisted: a module-level
 * Zustand store survives sub-tab switches and route changes (the two ways
 * users kept losing work — every AI Lab sub-tab unmounts on switch), while an
 * app restart intentionally starts fresh.
 *
 * Holds three kinds of state:
 *  1. the active sub-tab (so leaving /ai-lab and coming back doesn't reset
 *     you to Playground),
 *  2. cross-tab selection handoffs ("View report" jumps to Reports with the
 *     run selected; dataset dialogs select the dataset they created),
 *  3. form drafts for Playground / Evals / Arena, which used to be component
 *     state and evaporated on every tab switch.
 */

export type AiLabTab = 'playground' | 'datasets' | 'evals' | 'arena' | 'reports' | 'providers';

export type EvalTargetMode = 'text' | 'http' | 'graphql';

export interface PlaygroundDraft {
  system: string;
  user: string;
  varsText: string;
  /** Selected `providerConfigId:model` keys. */
  selected: string[];
  /** Raw input for the optional max-output-tokens cap ('' = provider default). */
  maxTokensText: string;
}

export interface EvalDraft {
  /** Stable eval-config id — re-running overwrites instead of accumulating. */
  configId: string;
  name: string;
  system: string;
  user: string;
  datasetId: string;
  selected: string[];
  scorers: ScorerConfig[];
  concurrency: number;
  targetMode: EvalTargetMode;
}

export interface ArenaDraft {
  datasetId: string;
  selected: string[];
  judgeKey: string;
  system: string;
  concurrency: number;
}

const defaultPlaygroundDraft = (): PlaygroundDraft => ({
  system: 'You are a helpful assistant.',
  user: 'Explain {{topic}} in one sentence.',
  varsText: '{\n  "topic": "HTTP caching"\n}',
  selected: [],
  maxTokensText: '',
});

const defaultEvalDraft = (): EvalDraft => ({
  configId: uuidv4(),
  name: 'My eval',
  system: 'You are concise.',
  user: 'Capital of {{country}}?',
  datasetId: '',
  selected: [],
  scorers: [],
  concurrency: 4,
  targetMode: 'text',
});

const defaultArenaDraft = (): ArenaDraft => ({
  datasetId: '',
  selected: [],
  judgeKey: '',
  system: '',
  concurrency: 4,
});

interface AiLabUiState {
  tab: AiLabTab;
  setTab: (tab: AiLabTab) => void;

  /** Report run to show in the Reports tab (null = newest). */
  reportRunId: string | null;
  setReportRunId: (id: string | null) => void;
  /** Case drilled into in the Reports tab (null = none). */
  reportDrillCaseId: string | null;
  setReportDrillCaseId: (id: string | null) => void;
  /** Convenience: select a run and jump to the Reports tab in one action. */
  openReport: (runId: string) => void;

  /** Dataset selected in the Datasets tab. */
  datasetId: string | null;
  setDatasetId: (id: string | null) => void;
  /** Select a dataset and jump to the Datasets tab. */
  openDataset: (datasetId: string) => void;

  /** Arena run shown in the results pane (null = latest). */
  arenaRunId: string | null;
  setArenaRunId: (id: string | null) => void;

  playgroundDraft: PlaygroundDraft;
  patchPlaygroundDraft: (patch: Partial<PlaygroundDraft>) => void;

  evalDraft: EvalDraft;
  patchEvalDraft: (patch: Partial<EvalDraft>) => void;
  /** Replace the whole draft (loading a saved eval / starting a new one). */
  setEvalDraft: (draft: EvalDraft) => void;
  newEvalDraft: () => void;

  arenaDraft: ArenaDraft;
  patchArenaDraft: (patch: Partial<ArenaDraft>) => void;
}

export const useAiLabUiStore = create<AiLabUiState>()((set) => ({
  tab: 'playground',
  setTab: (tab) => set({ tab }),

  reportRunId: null,
  setReportRunId: (id) => set({ reportRunId: id }),
  reportDrillCaseId: null,
  setReportDrillCaseId: (id) => set({ reportDrillCaseId: id }),
  openReport: (runId) => set({ reportRunId: runId, reportDrillCaseId: null, tab: 'reports' }),

  datasetId: null,
  setDatasetId: (id) => set({ datasetId: id }),
  openDataset: (datasetId) => set({ datasetId, tab: 'datasets' }),

  arenaRunId: null,
  setArenaRunId: (id) => set({ arenaRunId: id }),

  playgroundDraft: defaultPlaygroundDraft(),
  patchPlaygroundDraft: (patch) =>
    set((s) => ({ playgroundDraft: { ...s.playgroundDraft, ...patch } })),

  evalDraft: defaultEvalDraft(),
  patchEvalDraft: (patch) => set((s) => ({ evalDraft: { ...s.evalDraft, ...patch } })),
  setEvalDraft: (draft) => set({ evalDraft: draft }),
  newEvalDraft: () => set({ evalDraft: defaultEvalDraft() }),

  arenaDraft: defaultArenaDraft(),
  patchArenaDraft: (patch) => set((s) => ({ arenaDraft: { ...s.arenaDraft, ...patch } })),
}));
