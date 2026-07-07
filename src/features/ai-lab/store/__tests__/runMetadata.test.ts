import { describe, it, expect, beforeEach } from 'vitest';
import { useAiLabStore } from '../useAiLabStore';
import { useEvalRunStore } from '../useEvalRunStore';

describe('eval run metadata + config persistence', () => {
  beforeEach(() => {
    useEvalRunStore.setState({ runs: {} });
    useAiLabStore.setState({ providers: {}, prompts: {}, datasets: {}, evalConfigs: {} });
  });

  it('startRun records dataset + model labels for reports', () => {
    const id = useEvalRunStore.getState().startRun({
      evalConfigId: 'cfg',
      configName: 'My eval',
      totalCells: 2,
      datasetId: 'ds-1',
      datasetName: 'Smoke set',
      modelLabels: { 'p1:m1': 'Local · Llama 3.2' },
    });
    const run = useEvalRunStore.getState().runs[id]!;
    expect(run.datasetId).toBe('ds-1');
    expect(run.datasetName).toBe('Smoke set');
    expect(run.modelLabels).toEqual({ 'p1:m1': 'Local · Llama 3.2' });
  });

  it('startRun still works without the optional metadata', () => {
    const id = useEvalRunStore
      .getState()
      .startRun({ evalConfigId: 'cfg', configName: 'n', totalCells: 1 });
    const run = useEvalRunStore.getState().runs[id]!;
    expect(run.datasetId).toBeUndefined();
    expect(run.modelLabels).toBeUndefined();
  });

  it('upsertEvalConfig persists target and tools (previously dropped)', () => {
    const id = useAiLabStore.getState().upsertEvalConfig({
      name: 'exec eval',
      promptId: 'p',
      datasetId: 'd',
      models: [{ providerConfigId: 'p1', model: 'm1' }],
      scorers: [],
      concurrency: 2,
      target: { kind: 'http-exec', parseFrom: 'fenced', protocol: 'http' },
      tools: [{ name: 't', description: 'd', inputSchema: {} }],
    });
    const cfg = useAiLabStore.getState().evalConfigs[id]!;
    expect(cfg.target).toEqual({ kind: 'http-exec', parseFrom: 'fenced', protocol: 'http' });
    expect(cfg.tools).toHaveLength(1);
  });
});
