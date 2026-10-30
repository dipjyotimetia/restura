import type { CompletionResult } from '@shared/protocol/ai/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvalDraft } from '../../store/useAiLabUiStore';
import type {
  AiLabProviderConfig,
  AiToolDef,
  Dataset,
  EvalConfig,
  PromptTemplate,
} from '../../types';

const mockComplete = vi.hoisted(() => vi.fn());
vi.mock('@/features/ai-lab/lib/llmClient', () => ({
  completeLlm: mockComplete,
  specFor: (
    cfg: { provider: string },
    model: string,
    messages: unknown,
    options?: Record<string, unknown>
  ) => ({ provider: cfg.provider, model, messages, rawMode: true, ...options }),
  streamLlm: vi.fn(),
  listModels: vi.fn(),
  testConnection: vi.fn(),
}));

import { draftFromConfig, evalConfigFromDraft, targetFor, targetModeOf } from '../evalDraft';
import { runEval } from '../evalRunner';

const MODELS = [{ providerConfigId: 'p1', model: 'gpt-4o' }];
const LOOKUP: AiToolDef = {
  name: 'lookup',
  description: 'Look something up',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
};

const DRAFT: EvalDraft = {
  configId: 'eval-1',
  name: 'Tool eval',
  system: 'Use tools.',
  user: 'Find {{q}}',
  datasetId: 'd1',
  selected: ['p1:gpt-4o'],
  scorers: [],
  concurrency: 2,
  targetMode: 'text',
  passThresholdPct: 100,
  tools: [],
};

describe('eval draft <-> config (#1019)', () => {
  it('carries the draft tools into the EvalConfig', () => {
    const config = evalConfigFromDraft(
      { ...DRAFT, tools: [LOOKUP] },
      {
        promptId: 'pr',
        models: MODELS,
        now: 1,
      }
    );
    expect(config.tools).toEqual([LOOKUP]);
  });

  it('maps target modes both ways and defaults a missing prompt and threshold', () => {
    expect(targetFor('text')).toEqual({ kind: 'text' });
    expect(targetFor('graphql')).toEqual({
      kind: 'http-exec',
      parseFrom: 'fenced',
      protocol: 'graphql',
    });
    expect(targetModeOf(targetFor('http'))).toBe('http');
    expect(targetModeOf(undefined)).toBe('text');
    const draft = draftFromConfig(
      {
        id: 'e',
        name: 'n',
        promptId: 'pr',
        datasetId: 'd',
        models: MODELS,
        scorers: [],
        concurrency: 1,
        createdAt: 1,
        updatedAt: 1,
      },
      undefined
    );
    expect(draft).toMatchObject({ system: '', user: '', passThresholdPct: 100, tools: [] });
    expect(draft.sendUnredactedToCloud).toBe(false);
  });

  it('persists the unredacted override only when it is on', () => {
    const on = evalConfigFromDraft(
      { ...DRAFT, sendUnredactedToCloud: true },
      { promptId: 'pr', models: MODELS, now: 1 }
    );
    expect(on.sendUnredactedToCloud).toBe(true);
    const off = evalConfigFromDraft(DRAFT, { promptId: 'pr', models: MODELS, now: 1 });
    expect('sendUnredactedToCloud' in off).toBe(false);
  });

  it('omits tools when none are configured', () => {
    const config = evalConfigFromDraft(DRAFT, { promptId: 'pr', models: MODELS, now: 1 });
    expect('tools' in config).toBe(false);
  });

  it('keeps imported tools when a config is loaded and re-saved through the builder', () => {
    const imported: EvalConfig = {
      id: 'imp',
      name: 'Imported',
      promptId: 'pr',
      datasetId: 'd1',
      models: MODELS,
      scorers: [],
      concurrency: 2,
      tools: [LOOKUP],
      passThreshold: 0.75,
      sendUnredactedToCloud: true,
      createdAt: 0,
      updatedAt: 0,
    };
    const draft = draftFromConfig(imported, { system: 's', user: 'u' });
    expect(draft.tools).toEqual([LOOKUP]);
    const resaved = evalConfigFromDraft(draft, { promptId: 'pr', models: MODELS, now: 5 });
    expect(resaved).toMatchObject({
      tools: [LOOKUP],
      passThreshold: 0.75,
      sendUnredactedToCloud: true,
    });
  });
});

describe('tool-call scorer end to end (#1019)', () => {
  beforeEach(() => mockComplete.mockReset());

  const provider: AiLabProviderConfig = {
    id: 'p1',
    provider: 'openai',
    label: 'OpenAI',
    pricingKnown: true,
    isLocal: false,
    models: ['gpt-4o'],
    createdAt: 0,
  };
  const prompt: PromptTemplate = {
    id: 'pr',
    name: 'p',
    system: 'Use tools.',
    user: 'Find {{q}}',
    createdAt: 0,
    updatedAt: 0,
  };
  const dataset: Dataset = {
    id: 'd1',
    name: 'd',
    cases: [{ id: 'c1', vars: { q: 'cats' }, expected: '{"q":"cats"}' }],
    createdAt: 0,
    updatedAt: 0,
  };
  const called = (input: string): CompletionResult => ({
    ok: true,
    text: '',
    toolCalls: [{ id: 't1', name: 'lookup', input }],
  });

  const run = async () => {
    const config = evalConfigFromDraft(
      {
        ...DRAFT,
        tools: [LOOKUP],
        scorers: [
          { id: 's', kind: 'tool-call', expectedTool: 'lookup', expectedArgsFrom: 'expected' },
        ],
      },
      { promptId: 'pr', models: MODELS, now: 1 }
    );
    return runEval(
      {
        prompt,
        dataset,
        models: config.models,
        scorers: config.scorers,
        providers: { p1: provider },
        concurrency: 1,
        ...(config.tools ? { tools: config.tools } : {}),
      },
      () => {},
      new AbortController().signal
    );
  };

  it('offers the tools to the model and passes when the call matches', async () => {
    mockComplete.mockResolvedValue(called('{"q":"cats"}'));
    const cells = await run();
    expect(mockComplete.mock.calls[0]?.[0]).toMatchObject({ tools: [LOOKUP] });
    expect(cells[0]?.scores[0]).toMatchObject({ kind: 'tool-call', passed: true });
    expect(cells[0]?.passed).toBe(true);
  });

  it('fails when the called args differ from the case expected value', async () => {
    mockComplete.mockResolvedValue(called('{"q":"dogs"}'));
    const cells = await run();
    expect(cells[0]?.passed).toBe(false);
    expect(cells[0]?.scores[0]?.detail).toMatch(/do not match expected/);
  });
});
