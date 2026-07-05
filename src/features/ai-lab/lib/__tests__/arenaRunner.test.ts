import { describe, it, expect, vi } from 'vitest';
import type { AiLabProviderConfig, Dataset } from '../../types';

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
});
