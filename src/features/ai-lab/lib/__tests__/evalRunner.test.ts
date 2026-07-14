import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CompletionResult } from '@shared/protocol/ai/types';
import type { AiLabProviderConfig, Dataset, PromptTemplate, ScorerConfig } from '../../types';

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

  it('reports cost as unknown (null) for a priced model that returns no usage estimate', async () => {
    mockComplete.mockResolvedValue({ ok: true, text: 'x', toolCalls: [] }); // no usage
    const cells = await runEval(
      {
        prompt: PROMPT,
        dataset: { ...DATASET, cases: [DATASET.cases[0]!] },
        models: [{ providerConfigId: 'p1', model: 'gpt-4o' }],
        scorers: [],
        providers: { p1: PROVIDER }, // pricingKnown: true
        concurrency: 1,
      },
      () => {},
      new AbortController().signal
    );
    expect(cells[0]?.cost).toBeNull();
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

  it('forwards the run signal to model completion', async () => {
    mockComplete.mockResolvedValue(result('anything'));
    const controller = new AbortController();
    await runEval(
      {
        prompt: PROMPT,
        dataset: { ...DATASET, cases: [DATASET.cases[0]!] },
        models: [{ providerConfigId: 'p1', model: 'gpt-4o' }],
        scorers: [],
        providers: { p1: PROVIDER },
        concurrency: 1,
      },
      () => {},
      controller.signal
    );

    expect(mockComplete).toHaveBeenCalledWith(expect.anything(), { signal: controller.signal });
  });

  it('marks a zero-scorer cell as notEvaluated (not a pass)', async () => {
    mockComplete.mockResolvedValue(result('anything'));
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
    expect(cells[0]?.passed).toBe(false);
    expect(cells[0]?.notEvaluated).toBe(true);
  });

  it('builds messages from multi-turn case turns', async () => {
    mockComplete.mockResolvedValue(result('ok'));
    const turnsCase: Dataset = {
      ...DATASET,
      cases: [
        {
          id: 'c1',
          vars: { name: 'Ada' },
          turns: [
            { role: 'user', content: 'Hi I am {{name}}' },
            { role: 'assistant', content: 'Hello!' },
            { role: 'user', content: 'What is my name?' },
          ],
        },
      ],
    };
    await runEval(
      {
        prompt: PROMPT,
        dataset: turnsCase,
        models: [{ providerConfigId: 'p1', model: 'gpt-4o' }],
        scorers: [],
        providers: { p1: PROVIDER },
        concurrency: 1,
      },
      () => {},
      new AbortController().signal
    );
    const spec = mockComplete.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    // system + 3 turns; vars resolved inside turn content.
    expect(spec.messages).toHaveLength(4);
    expect(spec.messages[1]).toEqual({ role: 'user', content: 'Hi I am Ada' });
    expect(spec.messages[3]).toEqual({ role: 'user', content: 'What is my name?' });
  });

  it('http-exec target executes the parsed request and scores the response', async () => {
    mockComplete.mockResolvedValue(result('```json\n{"method":"GET","url":"https://x.test"}\n```'));
    const runRequest = vi.fn(async () => ({
      status: 200,
      statusText: 'OK',
      body: '{"ok":true}',
      latencyMs: 12,
      ok: true,
    }));
    const controller = new AbortController();
    const cells = await runEval(
      {
        prompt: PROMPT,
        dataset: { ...DATASET, cases: [DATASET.cases[0]!] },
        models: [{ providerConfigId: 'p1', model: 'gpt-4o' }],
        scorers: [{ id: 's', kind: 'contains', needle: '"ok":true' }],
        providers: { p1: PROVIDER },
        concurrency: 1,
        target: { kind: 'http-exec', parseFrom: 'fenced', protocol: 'http' },
        runRequest,
      },
      () => {},
      controller.signal
    );
    expect(runRequest).toHaveBeenCalledWith(expect.anything(), controller.signal);
    expect(cells[0]?.executed?.status).toBe(200);
    expect(cells[0]?.output).toBe('{"ok":true}');
    expect(cells[0]?.passed).toBe(true);
  });

  it('http-exec fails the cell when no request can be parsed', async () => {
    mockComplete.mockResolvedValue(result('I cannot help with that.'));
    const runRequest = vi.fn();
    const cells = await runEval(
      {
        prompt: PROMPT,
        dataset: { ...DATASET, cases: [DATASET.cases[0]!] },
        models: [{ providerConfigId: 'p1', model: 'gpt-4o' }],
        scorers: [{ id: 's', kind: 'contains', needle: 'x' }],
        providers: { p1: PROVIDER },
        concurrency: 1,
        target: { kind: 'http-exec', parseFrom: 'json', protocol: 'http' },
        runRequest,
      },
      () => {},
      new AbortController().signal
    );
    expect(runRequest).not.toHaveBeenCalled();
    expect(cells[0]?.passed).toBe(false);
    expect(cells[0]?.error).toMatch(/could not extract request/);
  });

  it.each([
    [{ ...PROVIDER, provider: 'ollama' as const, pricingKnown: false }, 0],
    [{ ...PROVIDER, pricingKnown: false }, null],
  ])('applies provider-specific unknown/free cost semantics', async (provider, expectedCost) => {
    mockComplete.mockResolvedValue(result('answer'));
    const cells = await runEval(
      {
        prompt: { ...PROMPT, system: '' },
        dataset: { ...DATASET, cases: [DATASET.cases[0]!] },
        models: [{ providerConfigId: 'p1', model: 'gpt-4o' }],
        scorers: [],
        providers: { p1: provider },
        concurrency: 1,
      },
      () => {},
      new AbortController().signal
    );
    expect(cells[0]?.cost).toBe(expectedCost);
    expect(mockComplete.mock.calls[0]?.[0].messages).toEqual([
      { role: 'user', content: 'Capital of France?' },
    ]);
  });

  it('fails a cell when its provider config was removed', async () => {
    const cells = await runEval(
      {
        prompt: PROMPT,
        dataset: { ...DATASET, cases: [DATASET.cases[0]!] },
        models: [{ providerConfigId: 'missing', model: 'ghost' }],
        scorers: [],
        providers: {},
        concurrency: 1,
      },
      () => {},
      new AbortController().signal
    );
    expect(cells[0]).toMatchObject({ ok: false, error: 'provider config not found' });
  });

  it('uses a fallback error when a failed completion omits provider details', async () => {
    mockComplete.mockResolvedValue({ ok: false, text: '', toolCalls: [] });
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
    expect(cells[0]?.error).toBe('model call failed');
  });

  it('forwards tools and fails closed when a configured judge provider is missing', async () => {
    mockComplete.mockResolvedValue(result('answer'));
    const cells = await runEval(
      {
        prompt: PROMPT,
        dataset: { ...DATASET, cases: [DATASET.cases[0]!] },
        models: [{ providerConfigId: 'p1', model: 'gpt-4o' }],
        tools: [
          {
            name: 'lookup',
            description: 'Look up a value',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
        scorers: [
          {
            id: 'judge',
            kind: 'judge',
            judgeModel: { providerConfigId: 'missing', model: 'judge' },
            rubric: 'correct',
            passThreshold: 0.5,
          },
        ],
        providers: { p1: PROVIDER },
        concurrency: 1,
      },
      () => {},
      new AbortController().signal
    );
    expect(mockComplete.mock.calls[0]?.[0].tools).toHaveLength(1);
    expect(cells[0]).toMatchObject({ ok: true, passed: false });
    expect(cells[0]?.scores[0]).toMatchObject({ kind: 'judge', passed: false });
  });

  it('fails http-exec when the request executor is unavailable', async () => {
    mockComplete.mockResolvedValue(result('{"method":"GET","url":"https://x.test"}'));
    const cells = await runEval(
      {
        prompt: PROMPT,
        dataset: { ...DATASET, cases: [DATASET.cases[0]!] },
        models: [{ providerConfigId: 'p1', model: 'gpt-4o' }],
        scorers: [],
        providers: { p1: PROVIDER },
        concurrency: 1,
        target: { kind: 'http-exec', parseFrom: 'json', protocol: 'http' },
      },
      () => {},
      new AbortController().signal
    );
    expect(cells[0]?.error).toBe('request executor unavailable');
  });

  it.each([[new Error('request broke')], ['string request failure']])(
    'records request execution failures',
    async (failure) => {
      mockComplete.mockResolvedValue(
        result('{"method":"POST","url":"https://x.test/graphql","query":"{ ping }"}')
      );
      const cells = await runEval(
        {
          prompt: PROMPT,
          dataset: { ...DATASET, cases: [DATASET.cases[0]!] },
          models: [{ providerConfigId: 'p1', model: 'gpt-4o' }],
          scorers: [],
          providers: { p1: PROVIDER },
          concurrency: 1,
          target: { kind: 'http-exec', parseFrom: 'json', protocol: 'graphql' },
          runRequest: vi.fn().mockRejectedValue(failure),
        },
        () => {},
        new AbortController().signal
      );
      expect(cells[0]?.error).toContain(
        failure instanceof Error ? failure.message : failure
      );
    }
  );

  it('runs a configured structured judge through the provider bridge', async () => {
    mockComplete
      .mockResolvedValueOnce(result('Paris'))
      .mockResolvedValueOnce({
        ok: true,
        text: '',
        toolCalls: [
          {
            id: 'judge',
            name: 'submit_judgment',
            input: JSON.stringify({
              criteria: [
                { name: 'overall', score: 0.9, pass: true, reasoning: 'correct' },
              ],
            }),
          },
        ],
      });
    const cells = await runEval(
      {
        prompt: PROMPT,
        dataset: {
          ...DATASET,
          cases: [{ ...DATASET.cases[0]!, reference: 'Paris' }],
        },
        models: [{ providerConfigId: 'p1', model: 'gpt-4o' }],
        scorers: [
          {
            id: 'judge',
            kind: 'judge',
            judgeModel: { providerConfigId: 'p1', model: 'gpt-4o' },
            rubric: 'Correctness',
            passThreshold: 0.5,
          },
        ],
        providers: { p1: PROVIDER },
        concurrency: 1,
      },
      () => {},
      new AbortController().signal
    );
    expect(cells[0]?.scores[0]).toMatchObject({ kind: 'judge', passed: true, score: 0.9 });
  });

  it.each([
    [{ name: 'quality', rubric: 'Prefer accuracy', weight: 1 }],
    [undefined],
  ])('runs pairwise judging with optional criteria and swapping', async (criterion) => {
    const comparison = (winner: 'A' | 'B') => ({
      ok: true,
      text: '',
      toolCalls: [
        {
          id: 'pairwise',
          name: 'submit_comparison',
          input: JSON.stringify({ winner, reasoning: 'better' }),
        },
      ],
    });
    mockComplete.mockResolvedValueOnce(result('candidate'));
    if (criterion) {
      mockComplete.mockResolvedValueOnce(comparison('A')).mockResolvedValueOnce(comparison('B'));
    } else {
      mockComplete.mockResolvedValueOnce(comparison('A'));
    }
    const cells = await runEval(
      {
        prompt: PROMPT,
        dataset: {
          ...DATASET,
          cases: [{ ...DATASET.cases[0]!, reference: 'baseline' }],
        },
        models: [{ providerConfigId: 'p1', model: 'gpt-4o' }],
        scorers: [
          {
            id: 'pairwise',
            kind: 'pairwise',
            judgeModel: { providerConfigId: 'p1', model: 'gpt-4o' },
            baseline: 'reference',
            passThreshold: 0.5,
            ...(criterion ? { criteria: [criterion], swapPositions: true } : {}),
          },
        ],
        providers: { p1: PROVIDER },
        concurrency: 1,
      },
      () => {},
      new AbortController().signal
    );
    expect(cells[0]?.scores[0]).toMatchObject({ kind: 'pairwise', passed: true });
  });
});
