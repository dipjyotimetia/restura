import { describe, it, expect, beforeEach } from 'vitest';
import { useAiLabStore } from '../useAiLabStore';

function reset() {
  useAiLabStore.setState({ providers: {}, prompts: {}, datasets: {}, evalConfigs: {} });
}

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

  it('updateProvider on an unknown id is a no-op', () => {
    useAiLabStore.getState().updateProvider('nope', { label: 'x' });
    expect(Object.keys(useAiLabStore.getState().providers)).toHaveLength(0);
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
