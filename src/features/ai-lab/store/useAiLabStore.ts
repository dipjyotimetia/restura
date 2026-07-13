import { AgentSuiteSchema, type AgentSuite, type ModelCapabilities } from '@shared/agent-lab';
import { isHuggingFaceProvider, isLocalProvider, type Provider } from '@shared/protocol/ai/types';
import { v4 as uuidv4 } from 'uuid';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { AiLabReportEnvelopeSchema, type AiLabReportEnvelope } from '../run-engine/reportEnvelope';
import { getAiLabReportRepository } from '../run-engine/reportRepository';
import {
  retainAgentReports,
  sanitizeAgentSuiteReportForPersistence,
} from '../run-engine/reportSanitizer';
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
  favoriteModelKeys: string[];
  recentModelKeys: string[];
  agentSuites: Record<string, AgentSuite>;
  runReports: Record<string, AiLabReportEnvelope>;
  reportQuarantineCount: number;
}

interface AiLabState extends PersistedAiLabState {
  // Providers
  addProvider: (init: {
    provider: Provider;
    label: string;
    baseUrl?: string;
    apiKeyHandleId?: string;
    pricingKnown?: boolean;
    costPolicy?: AiLabProviderConfig['costPolicy'];
    models?: string[];
    modelDetails?: Record<string, AiLabModelDetail>;
    capabilityOverrides?: Record<string, ModelCapabilities>;
    lastTest?: AiLabProviderConfig['lastTest'];
    lastDiscoveredAt?: number;
  }) => string;
  updateProvider: (id: string, patch: Partial<AiLabProviderConfig>) => void;
  removeProvider: (id: string) => void;
  setProviderModels: (
    id: string,
    models: string[],
    /** Optional per-model metadata keyed by model id. */
    modelDetails?: Record<string, AiLabModelDetail>
  ) => void;
  toggleFavoriteModel: (key: string) => void;
  recordRecentModels: (keys: string[]) => void;

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

  // Agent workbench
  upsertAgentSuite: (suite: unknown) => string;
  removeAgentSuite: (id: string) => void;
  hydrateRunReports: () => Promise<void>;
  saveRunReport: (report: AiLabReportEnvelope) => Promise<void>;
  removeRunReport: (id: string) => Promise<void>;
}

const DEFAULT_STATE: PersistedAiLabState = {
  providers: {},
  prompts: {},
  datasets: {},
  evalConfigs: {},
  favoriteModelKeys: [],
  recentModelKeys: [],
  agentSuites: {},
  runReports: {},
  reportQuarantineCount: 0,
};

const RECENT_MODEL_LIMIT = 20;
let reportMutationQueue: Promise<void> = Promise.resolve();

function enqueueReportMutation(operation: () => Promise<void>): Promise<void> {
  const pending = reportMutationQueue.then(operation, operation);
  reportMutationQueue = pending.catch(() => undefined);
  return pending;
}

export function migrateAiLabState(
  persisted: unknown,
  _version?: number
): Partial<PersistedAiLabState> {
  const previous = persisted as Partial<PersistedAiLabState>;
  let quarantineCount = previous.reportQuarantineCount ?? 0;
  const agentSuites = Object.fromEntries(
    Object.entries((previous.agentSuites ?? {}) as Record<string, unknown>).flatMap(
      ([id, value]) => {
        const parsed = AgentSuiteSchema.safeParse(value);
        if (parsed.success) return [[id, parsed.data]];
        quarantineCount += 1;
        console.warn(`[ai-lab] quarantined invalid agent suite "${id}"`);
        return [];
      }
    )
  );
  const runReports = Object.fromEntries(
    Object.entries((previous.runReports ?? {}) as Record<string, unknown>).flatMap(
      ([id, value]) => {
        const parsed = AiLabReportEnvelopeSchema.safeParse(value);
        if (parsed.success) {
          try {
            return [
              [
                id,
                parsed.data.kind === 'agent-suite'
                  ? sanitizeAgentSuiteReportForPersistence(parsed.data)
                  : parsed.data,
              ],
            ];
          } catch {
            quarantineCount += 1;
            console.warn(`[ai-lab] quarantined oversized run report "${id}"`);
            return [];
          }
        }
        quarantineCount += 1;
        console.warn(`[ai-lab] quarantined invalid run report "${id}"`);
        return [];
      }
    )
  );
  return {
    ...previous,
    providers: Object.fromEntries(
      Object.entries(previous.providers ?? {}).map(([id, config]) => {
        const modelDetails = config.modelDetails
          ? Object.fromEntries(
              Object.entries(config.modelDetails).map(([model, detail]) => {
                if (config.provider === 'openrouter') return [model, detail];
                const safeDetail: AiLabModelDetail = { ...detail };
                delete safeDetail.agentCapabilities;
                delete safeDetail.agentCapabilityProvenance;
                return [model, safeDetail];
              })
            )
          : undefined;
        return [
          id,
          {
            ...config,
            ...(modelDetails ? { modelDetails } : {}),
            costPolicy: config.costPolicy ?? 'unknown',
          },
        ];
      })
    ),
    agentSuites,
    runReports,
    reportQuarantineCount: quarantineCount,
  };
}

export const useAiLabStore = create<AiLabState>()(
  persist(
    (set, get) => ({
      ...DEFAULT_STATE,

      addProvider: (init) => {
        const id = uuidv4();
        const config: AiLabProviderConfig = {
          id,
          provider: init.provider,
          label: init.label,
          ...(init.baseUrl ? { baseUrl: init.baseUrl } : {}),
          ...(init.apiKeyHandleId ? { apiKeyHandleId: init.apiKeyHandleId } : {}),
          // Cloud providers with a static price table (openai/anthropic/
          // openrouter) default to pricingKnown=true. Local runtimes (Ollama,
          // openai-compatible) and HuggingFace (per-upstream pricing with no
          // static table) default to false — the AI Lab shows "cost unknown"
          // rather than a misleading $0.00 for paid-but-untabled models.
          pricingKnown:
            init.pricingKnown ??
            (!isLocalProvider(init.provider) && !isHuggingFaceProvider(init.provider)),
          costPolicy: init.costPolicy ?? 'unknown',
          isLocal: isLocalProvider(init.provider),
          models: init.models ?? [],
          ...(init.modelDetails ? { modelDetails: init.modelDetails } : {}),
          ...(init.capabilityOverrides ? { capabilityOverrides: init.capabilityOverrides } : {}),
          ...(init.lastTest ? { lastTest: init.lastTest } : {}),
          ...(init.lastDiscoveredAt ? { lastDiscoveredAt: init.lastDiscoveredAt } : {}),
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
          const prefix = `${id}:`;
          return {
            providers: next,
            favoriteModelKeys: s.favoriteModelKeys.filter((key) => !key.startsWith(prefix)),
            recentModelKeys: s.recentModelKeys.filter((key) => !key.startsWith(prefix)),
          };
        }),
      setProviderModels: (id, models, modelDetails) =>
        set((s) => {
          const existing = s.providers[id];
          if (!existing) return {};
          // Empty details object is treated as "no details" so a re-discover
          // with a provider whose endpoint no longer returns rich metadata
          // doesn't leave a stale (now-incomplete) `modelDetails` around.
          const hasDetails = modelDetails && Object.keys(modelDetails).length > 0;
          const modelSet = new Set(models);
          const retainedOverrides = Object.fromEntries(
            Object.entries(existing.capabilityOverrides ?? {}).filter(([model]) =>
              modelSet.has(model)
            )
          );
          return {
            providers: {
              ...s.providers,
              [id]: {
                ...existing,
                models,
                ...(hasDetails ? { modelDetails } : { modelDetails: undefined }),
                capabilityOverrides:
                  Object.keys(retainedOverrides).length > 0 ? retainedOverrides : undefined,
                lastDiscoveredAt: Date.now(),
              },
            },
          };
        }),
      toggleFavoriteModel: (key) =>
        set((s) => ({
          favoriteModelKeys: s.favoriteModelKeys.includes(key)
            ? s.favoriteModelKeys.filter((candidate) => candidate !== key)
            : [...s.favoriteModelKeys, key],
        })),
      recordRecentModels: (keys) =>
        set((s) => {
          const next = [...s.recentModelKeys];
          for (const key of keys) {
            const index = next.indexOf(key);
            if (index >= 0) next.splice(index, 1);
            next.unshift(key);
          }
          return { recentModelKeys: next.slice(0, RECENT_MODEL_LIMIT) };
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
                // Persist the full config — dropping target/tools here made a
                // reloaded http-exec eval silently score text again.
                ...(cfg.target ? { target: cfg.target } : {}),
                ...(cfg.tools ? { tools: cfg.tools } : {}),
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

      upsertAgentSuite: (input) => {
        const suite = AgentSuiteSchema.parse(input);
        set((state) => ({ agentSuites: { ...state.agentSuites, [suite.id]: suite } }));
        return suite.id;
      },
      removeAgentSuite: (id) =>
        set((state) => {
          const next = { ...state.agentSuites };
          delete next[id];
          return { agentSuites: next };
        }),
      hydrateRunReports: () =>
        enqueueReportMutation(async () => {
          const loaded = await getAiLabReportRepository().load();
          const migrated = migrateAiLabState({ runReports: loaded });
          const canonical = retainAgentReports({
            ...get().runReports,
            ...(migrated.runReports ?? {}),
          });
          if (JSON.stringify(canonical) !== JSON.stringify(loaded)) {
            await getAiLabReportRepository().save(canonical);
          }
          set({
            runReports: canonical,
            reportQuarantineCount:
              get().reportQuarantineCount + (migrated.reportQuarantineCount ?? 0),
          });
        }),
      saveRunReport: (report) =>
        enqueueReportMutation(async () => {
          const safe =
            report.kind === 'agent-suite' ? sanitizeAgentSuiteReportForPersistence(report) : report;
          const reports = retainAgentReports({ ...get().runReports, [safe.id]: safe });
          await getAiLabReportRepository().save(reports);
          set({ runReports: reports });
        }),
      removeRunReport: (id) =>
        enqueueReportMutation(async () => {
          const next = { ...get().runReports };
          delete next[id];
          await getAiLabReportRepository().save(next);
          set({ runReports: next });
        }),
    }),
    {
      name: 'ai-lab-store',
      storage: dexieStorageAdapters.aiLab(),
      version: 4,
      migrate: migrateAiLabState,
      partialize: (state) => ({
        providers: state.providers,
        prompts: state.prompts,
        datasets: state.datasets,
        evalConfigs: state.evalConfigs,
        favoriteModelKeys: state.favoriteModelKeys,
        recentModelKeys: state.recentModelKeys,
        agentSuites: state.agentSuites,
        reportQuarantineCount: state.reportQuarantineCount,
      }),
      merge: (persisted, current) => ({ ...current, ...migrateAiLabState(persisted) }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const parsed = AiLabStateSchema.safeParse(state);
        if (!parsed.success) {
          // Merge defaults (keep action methods) rather than replace.
          useAiLabStore.setState({ ...DEFAULT_STATE });
        }
        void state.hydrateRunReports().catch((cause) => {
          console.warn('[ai-lab] report hydration failed', cause);
        });
      },
    }
  )
);
