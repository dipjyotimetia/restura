import { describe, it, expect, beforeEach, vi } from 'vitest';
import { migrateAiLabState, useAiLabStore } from '../useAiLabStore';
import { AiLabStateSchema } from '@/lib/shared/store-validators';
import type { AiLabReportEnvelope } from '../../run-engine/reportEnvelope';
import {
  resetAiLabReportRepositoryForTests,
  setAiLabReportRepositoryForTests,
} from '../../run-engine/reportRepository';

function reset() {
  resetAiLabReportRepositoryForTests();
  useAiLabStore.setState({
    providers: {},
    prompts: {},
    datasets: {},
    evalConfigs: {},
    favoriteModelKeys: [],
    recentModelKeys: [],
    agentSuites: {},
    runReports: {},
    reportQuarantineCount: 0,
  });
}

function report(
  id: string,
  startedAt: number
): Extract<AiLabReportEnvelope, { kind: 'agent-suite' }> {
  return {
    id,
    kind: 'agent-suite',
    name: id,
    startedAt,
    finishedAt: startedAt + 1,
    status: 'passed',
    suite: {
      schemaVersion: 2,
      id: 'suite',
      name: 'suite',
      mode: 'regression',
      agents: [
        {
          id: 'agent',
          model: { providerId: 'provider', model: 'model' },
          instructions: 'safe',
          tools: [],
          limits: { maxSteps: 1, maxWallTimeMs: 1_000 },
        },
      ],
      tasks: [{ id: 'task', input: [{ type: 'text', text: 'safe' }] }],
      graders: [],
      trials: 1,
    },
    payload: {
      suiteId: 'suite',
      status: 'passed',
      results: [],
      summary: {
        total: 0,
        passed: 0,
        failed: 0,
        errors: 0,
        cancelled: 0,
        passRate: 0,
        confidence95: { low: 0, high: 0 },
        passAtK: {},
        passToK: {},
        reliabilityByCase: [],
      },
    },
  };
}

describe('useAiLabStore — canonical reports', () => {
  beforeEach(reset);

  it('hydrates retained reports from the awaited repository and persists eviction', async () => {
    const loaded = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => {
        const value = report(`r-${index}`, index);
        return [value.id, value];
      })
    );
    const save = vi.fn(async () => {});
    setAiLabReportRepositoryForTests({ load: async () => loaded, save });

    await useAiLabStore.getState().hydrateRunReports();

    expect(Object.keys(useAiLabStore.getState().runReports)).toHaveLength(20);
    expect(useAiLabStore.getState().runReports['r-24']).toBeDefined();
    expect(useAiLabStore.getState().runReports['r-0']).toBeUndefined();
    expect(save).toHaveBeenCalledWith(useAiLabStore.getState().runReports);
  });

  it('awaits canonical save and deletion before changing live report state', async () => {
    let persisted: Record<string, AiLabReportEnvelope> = {};
    const repository = {
      load: async () => persisted,
      save: vi.fn(async (next: Record<string, AiLabReportEnvelope>) => {
        persisted = structuredClone(next);
      }),
    };
    setAiLabReportRepositoryForTests(repository);
    const value = report('r-1', 1);

    await useAiLabStore.getState().saveRunReport(value);
    expect(persisted['r-1']).toEqual(value);
    expect(useAiLabStore.getState().runReports['r-1']).toEqual(value);

    await useAiLabStore.getState().removeRunReport('r-1');
    expect(persisted).toEqual({});
    expect(useAiLabStore.getState().runReports).toEqual({});
  });
});

describe('useAiLabStore — providers', () => {
  beforeEach(reset);

  it('adds a cloud provider with pricingKnown=true and isLocal=false', () => {
    const id = useAiLabStore
      .getState()
      .addProvider({ provider: 'openai', label: 'OpenAI', apiKeyHandleId: 'h1' });
    const cfg = useAiLabStore.getState().providers[id];
    expect(cfg?.provider).toBe('openai');
    expect(cfg?.pricingKnown).toBe(true);
    expect(cfg?.isLocal).toBe(false);
    expect(cfg?.apiKeyHandleId).toBe('h1');
  });

  it('adds a local provider with pricingKnown=false and isLocal=true by default', () => {
    const id = useAiLabStore
      .getState()
      .addProvider({ provider: 'ollama', label: 'Local', baseUrl: 'http://localhost:11434' });
    const cfg = useAiLabStore.getState().providers[id];
    expect(cfg?.isLocal).toBe(true);
    expect(cfg?.pricingKnown).toBe(false);
    expect(cfg?.baseUrl).toBe('http://localhost:11434');
    expect(cfg?.apiKeyHandleId).toBeUndefined();
  });

  it('honors an explicit pricingKnown override', () => {
    const id = useAiLabStore.getState().addProvider({
      provider: 'openai-compatible',
      label: 'Groq',
      baseUrl: 'https://api.groq.com',
      pricingKnown: true,
    });
    expect(useAiLabStore.getState().providers[id]?.pricingKnown).toBe(true);
  });

  it('adds a ready provider with its discovered catalog and connection state atomically', () => {
    const discoveredAt = 1_720_000_000_000;
    const id = useAiLabStore.getState().addProvider({
      provider: 'openrouter',
      label: 'OpenRouter',
      apiKeyHandleId: 'h1',
      models: ['anthropic/claude-3.5-sonnet'],
      modelDetails: {
        'anthropic/claude-3.5-sonnet': { label: 'Claude 3.5 Sonnet', contextLength: 200_000 },
      },
      lastTest: { ok: true, at: discoveredAt, modelCount: 1 },
      lastDiscoveredAt: discoveredAt,
    });

    expect(useAiLabStore.getState().providers[id]).toMatchObject({
      models: ['anthropic/claude-3.5-sonnet'],
      modelDetails: {
        'anthropic/claude-3.5-sonnet': { label: 'Claude 3.5 Sonnet', contextLength: 200_000 },
      },
      lastTest: { ok: true, at: discoveredAt, modelCount: 1 },
      lastDiscoveredAt: discoveredAt,
    });
  });

  it('persists explicit capability overrides while accepting legacy providers additively', () => {
    const capabilityOverride = {
      inputModalities: ['text'] as const,
      outputModalities: ['text'] as const,
      structuredOutput: false,
      toolCalling: true,
      parallelToolCalls: false,
      reasoning: false,
      continuation: false,
      serverTools: [],
    };
    const id = useAiLabStore.getState().addProvider({
      provider: 'openai-compatible',
      label: 'Gateway',
      models: ['custom'],
      capabilityOverrides: { custom: capabilityOverride },
    });

    expect(useAiLabStore.getState().providers[id]?.capabilityOverrides).toEqual({
      custom: capabilityOverride,
    });

    const legacyState = {
      providers: {
        legacy: {
          id: 'legacy',
          provider: 'ollama',
          label: 'Legacy local',
          pricingKnown: false,
          isLocal: true,
          models: ['old'],
          createdAt: 1,
        },
      },
      prompts: {},
      datasets: {},
      evalConfigs: {},
    };
    const parsedLegacy = AiLabStateSchema.safeParse(legacyState);
    expect(parsedLegacy.success).toBe(true);
    if (parsedLegacy.success) {
      expect(parsedLegacy.data.providers.legacy?.costPolicy).toBe('unknown');
    }
  });

  it('rejects unproven or inconsistent persisted discovery capabilities', () => {
    const base = {
      providers: {
        unsafe: {
          id: 'unsafe',
          provider: 'openrouter',
          label: 'Unsafe',
          pricingKnown: true,
          isLocal: false,
          models: ['custom'],
          createdAt: 1,
          modelDetails: {
            custom: {
              agentCapabilities: {
                inputModalities: ['text'],
                outputModalities: ['text'],
                toolCalling: false,
                parallelToolCalls: false,
              },
            },
          },
        },
      },
      prompts: {},
      datasets: {},
      evalConfigs: {},
    };

    expect(AiLabStateSchema.safeParse(base).success).toBe(false);
  });

  it('rejects proven discovery metadata with server tools but no tool calling', () => {
    const state = {
      providers: {
        unsafe: {
          id: 'unsafe',
          provider: 'openrouter',
          label: 'Unsafe',
          pricingKnown: true,
          isLocal: false,
          models: ['custom'],
          createdAt: 1,
          modelDetails: {
            custom: {
              agentCapabilities: {
                inputModalities: ['text'],
                outputModalities: ['text'],
                toolCalling: false,
                serverTools: ['web-search'],
              },
              agentCapabilityProvenance: {
                source: 'discovered',
                adapterId: 'openrouter.models',
                adapterVersion: 1,
              },
            },
          },
        },
      },
      prompts: {},
      datasets: {},
      evalConfigs: {},
    };

    expect(AiLabStateSchema.safeParse(state).success).toBe(false);
  });

  it('rejects OpenRouter capability provenance attached to a different provider', () => {
    const state = {
      providers: {
        mismatch: {
          id: 'mismatch',
          provider: 'anthropic',
          label: 'Imported Anthropic',
          pricingKnown: true,
          isLocal: false,
          models: ['custom'],
          createdAt: 1,
          modelDetails: {
            custom: {
              agentCapabilities: { toolCalling: true },
              agentCapabilityProvenance: {
                source: 'discovered',
                adapterId: 'openrouter.models',
                adapterVersion: 1,
              },
            },
          },
        },
      },
      prompts: {},
      datasets: {},
      evalConfigs: {},
    };

    expect(AiLabStateSchema.safeParse(state).success).toBe(false);
  });

  it('migration preserves a mismatched provider while stripping foreign capability evidence', () => {
    const migrated = migrateAiLabState({
      providers: {
        mismatch: {
          id: 'mismatch',
          provider: 'anthropic',
          label: 'Imported Anthropic',
          pricingKnown: true,
          isLocal: false,
          models: ['custom'],
          createdAt: 1,
          modelDetails: {
            custom: {
              label: 'Custom',
              agentCapabilities: { toolCalling: true },
              agentCapabilityProvenance: {
                source: 'discovered',
                adapterId: 'openrouter.models',
                adapterVersion: 1,
              },
            },
          },
        },
      },
      prompts: {},
      datasets: {},
      evalConfigs: {},
    });

    expect(migrated.providers?.mismatch).toMatchObject({
      id: 'mismatch',
      provider: 'anthropic',
      modelDetails: { custom: { label: 'Custom' } },
      costPolicy: 'unknown',
    });
    expect(migrated.providers?.mismatch?.modelDetails?.custom?.agentCapabilities).toBeUndefined();
    expect(
      migrated.providers?.mismatch?.modelDetails?.custom?.agentCapabilityProvenance
    ).toBeUndefined();
  });

  it('adds a HuggingFace provider with pricingKnown=false and isLocal=false', () => {
    // HuggingFace is a cloud gateway but has no static price table — pricing
    // must default to unknown so the AI Lab shows "cost unknown" rather than a
    // misleading $0.00 for paid-but-untabled models.
    const id = useAiLabStore.getState().addProvider({
      provider: 'huggingface',
      label: 'HuggingFace',
      apiKeyHandleId: 'hf-handle',
    });
    const cfg = useAiLabStore.getState().providers[id];
    expect(cfg?.provider).toBe('huggingface');
    expect(cfg?.isLocal).toBe(false);
    expect(cfg?.pricingKnown).toBe(false);
    expect(cfg?.apiKeyHandleId).toBe('hf-handle');
  });

  it('updates, sets models, and removes a provider', () => {
    const s = useAiLabStore.getState();
    const id = s.addProvider({ provider: 'ollama', label: 'L' });
    useAiLabStore.getState().setProviderModels(id, ['llama3.2', 'qwen']);
    expect(useAiLabStore.getState().providers[id]?.models).toEqual(['llama3.2', 'qwen']);
    useAiLabStore.getState().updateProvider(id, { label: 'Renamed' });
    expect(useAiLabStore.getState().providers[id]?.label).toBe('Renamed');
    useAiLabStore.getState().removeProvider(id);
    expect(useAiLabStore.getState().providers[id]).toBeUndefined();
  });

  it('prunes overrides on rediscovery so removed models cannot resurrect stale assertions', () => {
    const id = useAiLabStore.getState().addProvider({
      provider: 'openai-compatible',
      label: 'Gateway',
      models: ['keep', 'removed'],
      capabilityOverrides: {
        removed: {
          inputModalities: ['text'],
          outputModalities: ['text'],
          structuredOutput: false,
          toolCalling: true,
          parallelToolCalls: false,
          reasoning: false,
          continuation: false,
          serverTools: [],
        },
      },
    });

    useAiLabStore.getState().setProviderModels(id, ['keep']);
    expect(useAiLabStore.getState().providers[id]?.capabilityOverrides).toBeUndefined();

    useAiLabStore.getState().setProviderModels(id, ['keep', 'removed']);
    expect(useAiLabStore.getState().providers[id]?.capabilityOverrides).toBeUndefined();
  });

  it('updateProvider on an unknown id is a no-op', () => {
    useAiLabStore.getState().updateProvider('nope', { label: 'x' });
    expect(Object.keys(useAiLabStore.getState().providers)).toHaveLength(0);
  });

  it('favorites models, records recent use in recency order, and caps history at 20', () => {
    const state = useAiLabStore.getState();
    state.toggleFavoriteModel('p:m1');
    state.toggleFavoriteModel('p:m2');
    state.toggleFavoriteModel('p:m1');
    expect(useAiLabStore.getState().favoriteModelKeys).toEqual(['p:m2']);

    useAiLabStore
      .getState()
      .recordRecentModels(Array.from({ length: 22 }, (_, index) => `p:m${index}`));
    expect(useAiLabStore.getState().recentModelKeys).toHaveLength(20);
    expect(useAiLabStore.getState().recentModelKeys.slice(0, 3)).toEqual([
      'p:m21',
      'p:m20',
      'p:m19',
    ]);

    useAiLabStore.getState().recordRecentModels(['p:m10']);
    expect(useAiLabStore.getState().recentModelKeys[0]).toBe('p:m10');
    expect(useAiLabStore.getState().recentModelKeys).toHaveLength(20);
  });

  it('prunes favorite and recent model references when a provider is removed', () => {
    const id = useAiLabStore
      .getState()
      .addProvider({ provider: 'ollama', label: 'Local', models: ['llama3.2'] });
    const key = `${id}:llama3.2`;
    useAiLabStore.getState().toggleFavoriteModel(key);
    useAiLabStore.getState().recordRecentModels([key, 'another:model']);

    useAiLabStore.getState().removeProvider(id);

    expect(useAiLabStore.getState().favoriteModelKeys).toEqual([]);
    expect(useAiLabStore.getState().recentModelKeys).toEqual(['another:model']);
  });
});

describe('useAiLabStore — report migration', () => {
  it('migrates legacy eval state without rewriting existing runs', () => {
    const legacyRun = {
      id: 'legacy',
      evalConfigId: 'eval-1',
      configName: 'Legacy eval',
      startedAt: 1,
      status: 'done' as const,
      cells: [],
      totalCells: 0,
    };
    const legacyState = {
      providers: {},
      prompts: {},
      datasets: {},
      evalConfigs: {},
      runs: { legacy: legacyRun },
    };

    const migrated = migrateAiLabState(legacyState, 2) as typeof legacyState & {
      runReports: Record<string, unknown>;
    };

    expect(migrated.runs).toEqual({ legacy: legacyRun });
    expect(migrated.runReports).toEqual({});
  });

  it('isolates malformed suites and reports while preserving unrelated state', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const migrated = migrateAiLabState(
      {
        providers: { keep: { id: 'keep' } },
        prompts: { keep: { id: 'keep' } },
        datasets: { keep: { id: 'keep' } },
        evalConfigs: { keep: { id: 'keep' } },
        agentSuites: { bad: { schemaVersion: 2, id: 'bad' } },
        runReports: { bad: { id: 'bad', kind: 'agent-suite', payload: null } },
        runs: { legacy: { id: 'legacy' } },
      },
      4
    ) as Record<string, unknown>;

    expect(migrated.agentSuites).toEqual({});
    expect(migrated.runReports).toEqual({});
    expect(migrated.reportQuarantineCount).toBe(2);
    expect(migrated.providers).toMatchObject({ keep: { id: 'keep' } });
    expect(migrated.runs).toEqual({ legacy: { id: 'legacy' } });
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('useAiLabStore — prompts', () => {
  beforeEach(reset);

  it('creates a prompt, then updates it preserving createdAt', () => {
    const id = useAiLabStore.getState().upsertPrompt({ name: 'p', system: 's', user: 'u' });
    const createdAt = useAiLabStore.getState().prompts[id]?.createdAt;
    useAiLabStore.getState().upsertPrompt({ id, name: 'p2', system: 's2', user: 'u2' });
    const p = useAiLabStore.getState().prompts[id];
    expect(p?.name).toBe('p2');
    expect(p?.createdAt).toBe(createdAt);
    expect(p?.updatedAt).toBeGreaterThanOrEqual(createdAt ?? 0);
  });

  it('removes a prompt', () => {
    const id = useAiLabStore.getState().upsertPrompt({ name: 'p', system: '', user: 'u' });
    useAiLabStore.getState().removePrompt(id);
    expect(useAiLabStore.getState().prompts[id]).toBeUndefined();
  });
});

describe('useAiLabStore — datasets', () => {
  beforeEach(reset);

  it('creates a dataset and appends a case with a minted id', () => {
    const id = useAiLabStore.getState().upsertDataset({ name: 'd', cases: [] });
    useAiLabStore.getState().addCase(id, { vars: { a: '1' }, expected: 'x' });
    const ds = useAiLabStore.getState().datasets[id];
    expect(ds?.cases).toHaveLength(1);
    expect(ds?.cases[0]?.id).toBeTruthy();
    expect(ds?.cases[0]?.vars).toEqual({ a: '1' });
  });

  it('addCase on an unknown dataset is a no-op', () => {
    useAiLabStore.getState().addCase('nope', { vars: {} });
    expect(Object.keys(useAiLabStore.getState().datasets)).toHaveLength(0);
  });

  it('removes a dataset', () => {
    const id = useAiLabStore.getState().upsertDataset({ name: 'd', cases: [] });
    useAiLabStore.getState().removeDataset(id);
    expect(useAiLabStore.getState().datasets[id]).toBeUndefined();
  });
});

describe('useAiLabStore — eval configs', () => {
  beforeEach(reset);

  it('upserts and removes an eval config', () => {
    const id = useAiLabStore.getState().upsertEvalConfig({
      name: 'e',
      promptId: 'p',
      datasetId: 'd',
      models: [{ providerConfigId: 'pc', model: 'm' }],
      scorers: [],
      concurrency: 4,
    });
    expect(useAiLabStore.getState().evalConfigs[id]?.name).toBe('e');
    useAiLabStore.getState().removeEvalConfig(id);
    expect(useAiLabStore.getState().evalConfigs[id]).toBeUndefined();
  });
});
