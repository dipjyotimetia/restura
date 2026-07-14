import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { AiLabProviderConfig, Dataset } from '../../types';

const mockComplete = vi.hoisted(() => vi.fn());
vi.mock('@/features/ai-lab/lib/llmClient', () => ({
  completeLlm: mockComplete,
  specFor: (
    cfg: { provider: string },
    model: string,
    messages: unknown,
    options?: Record<string, unknown>
  ) => ({
    provider: cfg.provider,
    model,
    messages,
    rawMode: true,
    ...options,
  }),
  streamLlm: vi.fn(),
  listModels: vi.fn(),
  testConnection: vi.fn(),
}));

import { runArena } from '../arenaRunner';

const PROVIDER_A: AiLabProviderConfig = {
  id: 'p1',
  provider: 'openai',
  label: 'OpenAI',
  pricingKnown: true,
  isLocal: false,
  models: ['gpt-4o'],
  createdAt: 0,
};

const PROVIDER_B: AiLabProviderConfig = {
  id: 'p2',
  provider: 'anthropic',
  label: 'Anthropic',
  pricingKnown: true,
  isLocal: false,
  models: ['claude'],
  createdAt: 0,
};

const DATASET: Dataset = {
  id: 'd1',
  name: 'caps',
  cases: [{ id: 'c1', vars: { prompt: 'Capital of France?' } }],
  createdAt: 0,
  updatedAt: 0,
};

describe('runArena', () => {
  beforeEach(() => {
    mockComplete.mockReset();
  });

  it('throws instead of silently no-opping when a contestant provider config is missing', async () => {
    await expect(
      runArena(
        {
          dataset: DATASET,
          models: [
            { providerConfigId: 'p1', model: 'gpt-4o' },
            { providerConfigId: 'missing', model: 'ghost' },
          ],
          judgeModel: { providerConfigId: 'p1', model: 'gpt-4o' },
          // 'missing' is intentionally absent — simulates a provider removed
          // after being selected in the Arena config.
          providers: { p1: PROVIDER_A },
          concurrency: 2,
        },
        () => {},
        new AbortController().signal
      )
    ).rejects.toThrow(/missing:ghost/);
  });

  it('throws when the judge provider config is missing', async () => {
    await expect(
      runArena(
        {
          dataset: DATASET,
          models: [
            { providerConfigId: 'p1', model: 'gpt-4o' },
            { providerConfigId: 'p2', model: 'claude' },
          ],
          judgeModel: { providerConfigId: 'missing-judge', model: 'ghost' },
          providers: { p1: PROVIDER_A, p2: PROVIDER_B },
          concurrency: 2,
        },
        () => {},
        new AbortController().signal
      )
    ).rejects.toThrow(/missing-judge:ghost/);
  });

  it('generates both contestants and preserves a consistent swapped-order winner', async () => {
    const progress = vi.fn();
    const comparison = (winner: 'A' | 'B') => ({
      ok: true,
      text: '',
      toolCalls: [
        {
          id: 'judge',
          name: 'submit_comparison',
          input: JSON.stringify({ winner, reasoning: 'more accurate' }),
        },
      ],
    });
    let judgeCall = 0;
    mockComplete.mockImplementation(async (spec: { model: string; tools?: unknown[] }) => {
      if (spec.tools) return comparison(judgeCall++ === 0 ? 'A' : 'B');
      return { ok: true, text: `answer from ${spec.model}`, toolCalls: [] };
    });

    const result = await runArena(
      {
        dataset: DATASET,
        models: [
          { providerConfigId: 'p1', model: 'gpt-4o' },
          { providerConfigId: 'p2', model: 'claude' },
        ],
        judgeModel: { providerConfigId: 'p1', model: 'gpt-4o' },
        providers: { p1: PROVIDER_A, p2: PROVIDER_B },
        concurrency: 1,
        system: '  Be concise.  ',
      },
      progress,
      new AbortController().signal
    );

    expect(result).toEqual({
      modelKeys: ['p1:gpt-4o', 'p2:claude'],
      matches: [{ a: 'p1:gpt-4o', b: 'p2:claude', winner: 'a' }],
    });
    expect(mockComplete.mock.calls[0]?.[0].messages).toEqual([
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Capital of France?' },
    ]);
    expect(progress).toHaveBeenLastCalledWith({ phase: 'done', completed: 1, total: 1 });
  });

  it('uses input, question, and serialized vars fallbacks and stops before judging when aborted', async () => {
    const controller = new AbortController();
    const dataset: Dataset = {
      ...DATASET,
      cases: [
        { id: 'input', vars: { input: 'from input' } },
        { id: 'question', vars: { question: 'from question' } },
        { id: 'json', vars: { topic: 'from json' } },
      ],
    };
    mockComplete.mockImplementation(async () => {
      if (mockComplete.mock.calls.length === 6) controller.abort();
      return { ok: true, text: 'answer', toolCalls: [] };
    });

    const result = await runArena(
      {
        dataset,
        models: [
          { providerConfigId: 'p1', model: 'gpt-4o' },
          { providerConfigId: 'p2', model: 'claude' },
        ],
        judgeModel: { providerConfigId: 'p1', model: 'gpt-4o' },
        providers: { p1: PROVIDER_A, p2: PROVIDER_B },
        concurrency: 1,
        system: '   ',
      },
      () => {},
      controller.signal
    );

    expect(result.matches).toEqual([]);
    expect(mockComplete.mock.calls.map((call) => call[0].messages.at(-1)?.content)).toEqual([
      'from input',
      'from input',
      'from question',
      'from question',
      '{"topic":"from json"}',
      '{"topic":"from json"}',
    ]);
  });

  it('records a tie when the pairwise judge fails', async () => {
    mockComplete.mockImplementation(async (spec: { tools?: unknown[] }) => {
      if (spec.tools) throw new Error('invalid judge response');
      return { ok: true, text: 'answer', toolCalls: [] };
    });

    const result = await runArena(
      {
        dataset: DATASET,
        models: [
          { providerConfigId: 'p1', model: 'gpt-4o' },
          { providerConfigId: 'p2', model: 'claude' },
        ],
        judgeModel: { providerConfigId: 'p1', model: 'gpt-4o' },
        providers: { p1: PROVIDER_A, p2: PROVIDER_B },
        concurrency: 2,
      },
      () => {},
      new AbortController().signal
    );

    expect(result.matches).toEqual([
      { a: 'p1:gpt-4o', b: 'p2:claude', winner: 'tie' },
    ]);
  });

  it('does not call the judge when both contestant generations fail', async () => {
    mockComplete.mockResolvedValue({
      ok: false,
      text: '',
      toolCalls: [],
      error: { code: 'auth', message: 'bad key' },
    });

    const result = await runArena(
      {
        dataset: DATASET,
        models: [
          { providerConfigId: 'p1', model: 'gpt-4o' },
          { providerConfigId: 'p2', model: 'claude' },
        ],
        judgeModel: { providerConfigId: 'p1', model: 'gpt-4o' },
        providers: { p1: PROVIDER_A, p2: PROVIDER_B },
        concurrency: 2,
      },
      () => {},
      new AbortController().signal
    );

    expect(mockComplete).toHaveBeenCalledTimes(2);
    expect(result.matches[0]?.winner).toBe('tie');
  });
});
