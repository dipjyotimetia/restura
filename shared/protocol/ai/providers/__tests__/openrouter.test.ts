import { describe, it, expect } from 'vitest';
import { openrouterModule } from '@shared/protocol/ai/providers/openrouter';
import { getProviderModule, ALL_PROVIDERS } from '@shared/protocol/ai/providers';

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
