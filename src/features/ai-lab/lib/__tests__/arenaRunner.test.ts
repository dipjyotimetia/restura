import { beforeEach, describe, expect, it, vi } from 'vitest';
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

import { ArenaRunError, arenaRunStatus, runArena } from '../arenaRunner';

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

  it('records an errored match, not a tie, when the pairwise judge fails', async () => {
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
      { a: 'p1:gpt-4o', b: 'p2:claude', winner: 'error', error: 'judge: invalid judge response' },
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
    expect(result.matches[0]).toMatchObject({ winner: 'error' });
    expect(result.matches[0]?.error).toMatch(/bad key/);
  });

  it('marks a match errored when only one contestant call fails', async () => {
    mockComplete.mockImplementation(async (spec: { model: string }) =>
      spec.model === 'claude'
        ? { ok: false, text: '', toolCalls: [], error: { code: 'auth', message: 'bad key' } }
        : { ok: true, text: 'answer', toolCalls: [] }
    );

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

    expect(mockComplete).toHaveBeenCalledTimes(2); // no judge call on a failed contestant
    expect(result.matches).toEqual([
      { a: 'p1:gpt-4o', b: 'p2:claude', winner: 'error', error: 'p2:claude: bad key' },
    ]);
  });

  it('keeps already-collected matches on the error thrown by a failing run', async () => {
    mockComplete.mockResolvedValue({ ok: true, text: 'answer', toolCalls: [] });
    const onProgress = (p: { phase: string }) => {
      if (p.phase === 'judging') throw new Error('progress sink exploded');
    };
    const run = runArena(
      {
        dataset: DATASET,
        models: [
          { providerConfigId: 'p1', model: 'gpt-4o' },
          { providerConfigId: 'p2', model: 'claude' },
        ],
        judgeModel: { providerConfigId: 'p1', model: 'gpt-4o' },
        providers: { p1: PROVIDER_A, p2: PROVIDER_B },
        concurrency: 1,
      },
      onProgress,
      new AbortController().signal
    );
    await expect(run).rejects.toBeInstanceOf(ArenaRunError);
    await run.catch((e: ArenaRunError) => {
      expect(e.message).toBe('progress sink exploded');
      expect(e.matches).toHaveLength(1);
    });
  });
});

describe('runArena cancellation (#1020)', () => {
  const MODELS = [
    { providerConfigId: 'p1', model: 'gpt-4o' },
    { providerConfigId: 'p2', model: 'claude' },
  ];
  const abortError = () => new DOMException('Operation cancelled', 'AbortError');
  const base = (signal: AbortSignal) => ({
    input: {
      dataset: DATASET,
      models: MODELS,
      judgeModel: { providerConfigId: 'p1', model: 'gpt-4o' },
      providers: { p1: PROVIDER_A, p2: PROVIDER_B },
      concurrency: 2,
    },
    signal,
  });

  beforeEach(() => {
    mockComplete.mockReset();
  });

  it('passes the abort signal to every contestant and judge completeLlm call', async () => {
    const controller = new AbortController();
    mockComplete.mockImplementation(async (spec: { tools?: unknown[] }) =>
      spec.tools
        ? {
            ok: true,
            text: '',
            toolCalls: [{ id: 'j', name: 'submit_comparison', input: '{"winner":"A"}' }],
          }
        : { ok: true, text: 'answer', toolCalls: [] }
    );
    const { input, signal } = base(controller.signal);
    await runArena(input, () => {}, signal);

    expect(mockComplete.mock.calls.length).toBeGreaterThanOrEqual(4);
    for (const call of mockComplete.mock.calls) expect(call[1]).toEqual({ signal });
  });

  it('does not record a contestant call aborted by Stop as an errored match', async () => {
    const controller = new AbortController();
    mockComplete.mockImplementation(async () => {
      controller.abort();
      throw abortError();
    });
    const { input, signal } = base(controller.signal);
    const result = await runArena(input, () => {}, signal);
    expect(result.matches).toEqual([]);
  });

  it('does not record a judge call aborted by Stop as an errored match', async () => {
    const controller = new AbortController();
    mockComplete.mockImplementation(async (spec: { tools?: unknown[] }) => {
      if (spec.tools) {
        controller.abort();
        throw abortError();
      }
      return { ok: true, text: 'answer', toolCalls: [] };
    });
    const { input, signal } = base(controller.signal);
    const result = await runArena(input, () => {}, signal);
    expect(result.matches).toEqual([]);
    expect(arenaRunStatus(result.matches, signal.aborted)).toBe('cancelled');
  });
});

describe('arenaRunStatus', () => {
  const ok = { a: 'x', b: 'y', winner: 'a' as const };
  const bad = { a: 'x', b: 'y', winner: 'error' as const, error: 'boom' };

  it('is done when every match succeeded or there were none', () => {
    expect(arenaRunStatus([ok, { ...ok, winner: 'tie' }], false)).toBe('done');
    expect(arenaRunStatus([], false)).toBe('done');
  });
  it('is partial when some matches errored and error when all did', () => {
    expect(arenaRunStatus([ok, bad], false)).toBe('partial');
    expect(arenaRunStatus([bad, bad], false)).toBe('error');
  });
  it('is cancelled when aborted regardless of errored matches', () => {
    expect(arenaRunStatus([ok, bad], true)).toBe('cancelled');
  });
});
