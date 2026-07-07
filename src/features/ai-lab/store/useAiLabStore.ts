import { isLocalProvider, type Provider } from '@shared/protocol/ai/types';
import { v4 as uuidv4 } from 'uuid';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  AiLabModelDetail,
  AiLabProviderConfig,
  Dataset,
  DatasetCase,
  EvalConfig,
  PromptTemplate,
} from '../types';
import { dexieStorageAdapters } from '@/lib/shared/dexie-storage';
import { AiLabStateSchema } from '@/lib/shared/store-validators';

interface PersistedAiLabState {
  providers: Record<string, AiLabProviderConfig>;
  prompts: Record<string, PromptTemplate>;
  datasets: Record<string, Dataset>;
  evalConfigs: Record<string, EvalConfig>;
}

interface AiLabState extends PersistedAiLabState {
  // Providers
  addProvider: (init: {
    provider: Provider;
    label: string;
    baseUrl?: string;
    apiKeyHandleId?: string;
    pricingKnown?: boolean;
    models?: string[];
  }) => string;
  updateProvider: (id: string, patch: Partial<AiLabProviderConfig>) => void;
  removeProvider: (id: string) => void;
  setProviderModels: (
    id: string,
    models: string[],
    /** Optional per-model metadata keyed by model id. */
    modelDetails?: Record<string, AiLabModelDetail>
  ) => void;

  // Prompts
  upsertPrompt: (
    prompt: Omit<PromptTemplate, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
  ) => string;
  removePrompt: (id: string) => void;

  // Datasets
  upsertDataset: (
    dataset: Omit<Dataset, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
  ) => string;
  removeDataset: (id: string) => void;
  addCase: (datasetId: string, c: Omit<DatasetCase, 'id'>) => void;

  // Eval configs
  upsertEvalConfig: (
    cfg: Omit<EvalConfig, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
  ) => string;
  removeEvalConfig: (id: string) => void;
}

const DEFAULT_STATE: PersistedAiLabState = {
  providers: {},
  prompts: {},
  datasets: {},
  evalConfigs: {},
};

export const useAiLabStore = create<AiLabState>()(
  persist(
    (set) => ({
      ...DEFAULT_STATE,

      addProvider: (init) => {
        const id = uuidv4();
        const config: AiLabProviderConfig = {
          id,
          provider: init.provider,
          label: init.label,
          ...(init.baseUrl ? { baseUrl: init.baseUrl } : {}),
          ...(init.apiKeyHandleId ? { apiKeyHandleId: init.apiKeyHandleId } : {}),
          // Cloud providers have known pricing tables; local/compat default to unknown.
          pricingKnown: init.pricingKnown ?? !isLocalProvider(init.provider),
          isLocal: isLocalProvider(init.provider),
          models: init.models ?? [],
          createdAt: Date.now(),
        };
        set((s) => ({ providers: { ...s.providers, [id]: config } }));
        return id;
      },
      updateProvider: (id, patch) =>
        set((s) => {
          const existing = s.providers[id];
          if (!existing) return {};
          return { providers: { ...s.providers, [id]: { ...existing, ...patch } } };
        }),
      removeProvider: (id) =>
        set((s) => {
          const next = { ...s.providers };
          delete next[id];
          return { providers: next };
        }),
      setProviderModels: (id, models, modelDetails) =>
        set((s) => {
          const existing = s.providers[id];
          if (!existing) return {};
          // Empty details object is treated as "no details" so a re-discover
          // with a provider whose endpoint no longer returns rich metadata
          // doesn't leave a stale (now-incomplete) `modelDetails` around.
          const hasDetails = modelDetails && Object.keys(modelDetails).length > 0;
          return {
            providers: {
              ...s.providers,
              [id]: {
                ...existing,
                models,
                ...(hasDetails ? { modelDetails } : { modelDetails: undefined }),
              },
            },
          };
        }),

      upsertPrompt: (prompt) => {
        const id = prompt.id ?? uuidv4();
        set((s) => {
          const prev = s.prompts[id];
          const now = Date.now();
          return {
            prompts: {
              ...s.prompts,
              [id]: {
                id,
                name: prompt.name,
                system: prompt.system,
                user: prompt.user,
                createdAt: prev?.createdAt ?? now,
                updatedAt: now,
              },
            },
          };
        });
        return id;
      },
      removePrompt: (id) =>
        set((s) => {
          const next = { ...s.prompts };
          delete next[id];
          return { prompts: next };
        }),

      upsertDataset: (dataset) => {
        const id = dataset.id ?? uuidv4();
        set((s) => {
          const prev = s.datasets[id];
          const now = Date.now();
          return {
            datasets: {
              ...s.datasets,
              [id]: {
                id,
                name: dataset.name,
                cases: dataset.cases,
                createdAt: prev?.createdAt ?? now,
                updatedAt: now,
              },
            },
          };
        });
        return id;
      },
      removeDataset: (id) =>
        set((s) => {
          const next = { ...s.datasets };
          delete next[id];
          return { datasets: next };
        }),
      addCase: (datasetId, c) =>
        set((s) => {
          const ds = s.datasets[datasetId];
          if (!ds) return {};
          const newCase: DatasetCase = { id: uuidv4(), ...c };
          return {
            datasets: {
              ...s.datasets,
              [datasetId]: { ...ds, cases: [...ds.cases, newCase], updatedAt: Date.now() },
            },
          };
        }),

      upsertEvalConfig: (cfg) => {
        const id = cfg.id ?? uuidv4();
        set((s) => {
          const prev = s.evalConfigs[id];
          const now = Date.now();
          return {
            evalConfigs: {
              ...s.evalConfigs,
              [id]: {
                id,
                name: cfg.name,
                promptId: cfg.promptId,
                datasetId: cfg.datasetId,
                models: cfg.models,
                scorers: cfg.scorers,
                concurrency: cfg.concurrency,
                createdAt: prev?.createdAt ?? now,
                updatedAt: now,
              },
            },
          };
        });
        return id;
      },
      removeEvalConfig: (id) =>
        set((s) => {
          const next = { ...s.evalConfigs };
          delete next[id];
          return { evalConfigs: next };
        }),
    }),
    {
      name: 'ai-lab-store',
      storage: dexieStorageAdapters.aiLab(),
      version: 1,
      partialize: (state) => ({
        providers: state.providers,
        prompts: state.prompts,
        datasets: state.datasets,
        evalConfigs: state.evalConfigs,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const parsed = AiLabStateSchema.safeParse(state);
        if (!parsed.success) {
          // Merge defaults (keep action methods) rather than replace.
          useAiLabStore.setState({ ...DEFAULT_STATE });
        }
      },
    }
  )
);
