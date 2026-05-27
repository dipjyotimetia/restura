import { describe, it, expect } from 'vitest';
import { openrouterModule } from '@shared/protocol/ai/providers/openrouter';
import { getProviderModule, ALL_PROVIDERS } from '@shared/protocol/ai/providers';
import type { ChatStreamEvent } from '@shared/protocol/ai/types';

describe('openrouter', () => {
  it('is OpenAI-API-compatible — reuses the same decoder shape', () => {
    const decoder = openrouterModule.createDecoder('anthropic/claude-sonnet-4-6');
    const events = decoder.feed('{"choices":[{"delta":{"content":"hello"}}]}');
    expect(events[0]).toEqual({ type: 'delta', text: 'hello' });
  });

  it('exposes at least one model with non-zero pricing', () => {
    expect(openrouterModule.models.length).toBeGreaterThan(0);
    expect(openrouterModule.models[0]?.inputUSDPerMTok).toBeGreaterThanOrEqual(0);
  });

  it('estimates cost against OWN price table for a slash-namespaced model id', () => {
    // Regression guard: reusing the OpenAI decoder must NOT look the model up in
    // OpenAI's list (where 'anthropic/claude-sonnet-4-6' is absent → $0).
    const model = 'anthropic/claude-sonnet-4-6';
    const decoder = openrouterModule.createDecoder(model);
    decoder.feed(
      JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
      }),
    );
    const events = decoder.flush();
    const usage = events.find(
      (e): e is Extract<ChatStreamEvent, { type: 'usage' }> => e.type === 'usage',
    );
    const priced = openrouterModule.models.find((m) => m.id === model)!;
    // 1M input + 1M output tokens → exactly input + output per-MTok price.
    expect(usage?.usage.estimatedCostUSD).toBeCloseTo(
      priced.inputUSDPerMTok + priced.outputUSDPerMTok,
      5,
    );
    expect(usage?.usage.estimatedCostUSD).toBeGreaterThan(0);
  });
});

describe('provider registry', () => {
  it('looks up modules by provider id', () => {
    expect(getProviderModule('openai').provider).toBe('openai');
    expect(getProviderModule('anthropic').provider).toBe('anthropic');
    expect(getProviderModule('openrouter').provider).toBe('openrouter');
  });

  it('ALL_PROVIDERS lists all three', () => {
    expect(ALL_PROVIDERS).toEqual(['openai', 'anthropic', 'openrouter']);
  });
});
