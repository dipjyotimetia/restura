import { describe, expect, it } from 'vitest';
import { PROVIDER_ROUTES } from '../provider-routes';
import type { ChatRequestSpec } from '../types';

function spec(provider: ChatRequestSpec['provider'], extra?: Partial<ChatRequestSpec>) {
  return {
    provider,
    model: 'model',
    apiKeyHandleId: '',
    rawMode: true,
    messages: [
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'hi' },
    ],
    ...extra,
  } satisfies ChatRequestSpec;
}

const body = (provider: ChatRequestSpec['provider'], extra?: Partial<ChatRequestSpec>) =>
  JSON.parse(PROVIDER_ROUTES[provider].buildRequest(spec(provider, extra), 'key').body);

describe('provider request shape', () => {
  it('Anthropic caches the stable system prefix and the growing tail', () => {
    const b = body('anthropic');
    expect(b.cache_control).toEqual({ type: 'ephemeral' });
    expect(b.system).toEqual([
      { type: 'text', text: 'You are terse.', cache_control: { type: 'ephemeral' } },
    ]);
    expect(b.max_tokens).toBe(8192);
  });

  it('Anthropic omits system entirely when there is none', () => {
    const b = body('anthropic', { messages: [{ role: 'user', content: 'hi' }] });
    expect(b.system).toBeUndefined();
  });

  it('OpenAI uses max_completion_tokens (GPT-5+/6 reject max_tokens)', () => {
    const b = body('openai');
    expect(b.max_completion_tokens).toBe(16384);
    expect(b.max_tokens).toBeUndefined();
    expect(body('openai', { maxOutputTokens: 500 }).max_completion_tokens).toBe(500);
  });

  it('OpenAI-compatible providers keep max_tokens', () => {
    for (const p of ['openrouter', 'ollama', 'openai-compatible'] as const) {
      expect(body(p).max_tokens).toBe(8192);
    }
  });
});
