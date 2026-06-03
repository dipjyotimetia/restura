import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CompletionResult } from '@shared/protocol/ai/types';
import type { AiLabProviderConfig, Dataset, PromptTemplate, ScorerConfig } from '../../types';

const mockComplete = vi.hoisted(() => vi.fn());
vi.mock('@/features/ai-lab/lib/llmClient', () => ({
  completeLlm: mockComplete,
  specFor: (cfg: { provider: string }, model: string, messages: unknown) => ({
    provider: cfg.provider,
    model,
    messages,
    rawMode: true,
  }),
  streamLlm: vi.fn(),
  listModels: vi.fn(),
  testConnection: vi.fn(),
}));

import { runEval } from '../evalRunner';

const PROVIDER: AiLabProviderConfig = {
  id: 'p1',
  provider: 'openai',
  label: 'OpenAI',
  pricingKnown: true,
  isLocal: false,
  models: ['gpt-4o'],
  createdAt: 0,
};

const PROMPT: PromptTemplate = {
  id: 'pr1',
  name: 'p',
  system: 'You answer in one word.',
  user: 'Capital of {{country}}?',
  createdAt: 0,
  updatedAt: 0,
};

const DATASET: Dataset = {
  id: 'd1',
  name: 'caps',
  cases: [
    { id: 'c1', vars: { country: 'France' }, expected: 'Paris' },
    { id: 'c2', vars: { country: 'Japan' }, expected: 'Tokyo' },
  ],
  createdAt: 0,
  updatedAt: 0,
};

function result(text: string): CompletionResult {
  return {
    ok: true,
    text,
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 1, estimatedCostUSD: 0.002 },
  };
}

describe('runEval', () => {
  beforeEach(() => mockComplete.mockReset());

  it('runs case × model cells, scores them, and reports progress', async () => {
    mockComplete.mockResolvedValue(result('The capital is a city.'));
    // A scorer that deterministically matches the fixed output, so this test
    // exercises the run/score/progress machinery without depending on per-case
    // prompt routing through the mock.
    const scorers: ScorerConfig[] = [{ id: 's', kind: 'contains', needle: 'capital' }];
    const progress: number[] = [];
    const cells = await runEval(
      {
        prompt: PROMPT,
        dataset: DATASET,
        models: [{ providerConfigId: 'p1', model: 'gpt-4o' }],
        scorers,
        providers: { p1: PROVIDER },
        concurrency: 2,
      },
      (p) => progress.push(p.completed),
      new AbortController().signal
    );
    expect(cells).toHaveLength(2);
    expect(cells.every((c) => c.ok && c.passed)).toBe(true);
    expect(cells[0]?.cost).toBe(0.002); // priced cloud provider
    expect(mockComplete).toHaveBeenCalledTimes(2);
    expect(progress.at(-1)).toBe(2);
  });

  it('marks a failed model call as not passed and records the error', async () => {
    mockComplete.mockResolvedValue({
      ok: false,
      text: '',
      toolCalls: [],
      error: { code: 'provider', message: 'boom' },
    });
    const cells = await runEval(
      {
        prompt: PROMPT,
        dataset: { ...DATASET, cases: [DATASET.cases[0]!] },
        models: [{ providerConfigId: 'p1', model: 'gpt-4o' }],
        scorers: [],
        providers: { p1: PROVIDER },
        concurrency: 1,
      },
      () => {},
      new AbortController().signal
    );
    expect(cells[0]?.ok).toBe(false);
    expect(cells[0]?.error).toBe('boom');
    expect(cells[0]?.passed).toBe(false);
  });

  it('stops dispatching new cells once aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const cells = await runEval(
      {
        prompt: PROMPT,
        dataset: DATASET,
        models: [{ providerConfigId: 'p1', model: 'gpt-4o' }],
        scorers: [],
        providers: { p1: PROVIDER },
        concurrency: 2,
      },
      () => {},
      ac.signal
    );
    expect(cells).toHaveLength(0);
    expect(mockComplete).not.toHaveBeenCalled();
  });
});
