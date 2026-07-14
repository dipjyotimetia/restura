import { PROVIDER_ROUTES } from '@shared/protocol/ai/provider-routes';
import { ALL_PROVIDERS, getProviderModule, huggingfaceModule } from '@shared/protocol/ai/providers';
import { type ChatRequestSpec, isHuggingFaceProvider } from '@shared/protocol/ai/types';
import { describe, expect, it } from 'vitest';

function spec(over: Partial<ChatRequestSpec> = {}): ChatRequestSpec {
  return {
    provider: 'huggingface',
    model: 'meta-llama/Llama-3.3-70B-Instruct',
    messages: [{ role: 'user', content: 'hi' }],
    apiKeyHandleId: 'handle-hf',
    rawMode: false,
    ...over,
  };
}

describe('huggingface route', () => {
  it('targets the default router base and sends Bearer auth', () => {
    const built = PROVIDER_ROUTES.huggingface.buildRequest(spec(), 'hf_token');
    expect(built.url).toBe('https://router.huggingface.co/v1/chat/completions');
    expect(built.headers.Authorization).toBe('Bearer hf_token');
    const body = JSON.parse(built.body) as { model: string; stream: boolean };
    expect(body.model).toBe('meta-llama/Llama-3.3-70B-Instruct');
    expect(body.stream).toBe(true);
  });

  it('honors a base URL override', () => {
    const built = PROVIDER_ROUTES.huggingface.buildRequest(
      spec({ baseUrlOverride: 'https://custom-hf-gateway.example/' }),
      'hf_token'
    );
    expect(built.url).toBe('https://custom-hf-gateway.example/v1/chat/completions');
  });

  it('omits Authorization when keyless (lets the provider return its own 401)', () => {
    const built = PROVIDER_ROUTES.huggingface.buildRequest(spec({ apiKeyHandleId: '' }), '');
    expect(built.headers.Authorization).toBeUndefined();
  });
});

describe('huggingface provider module', () => {
  it('is OpenAI-API-compatible — reuses the same decoder shape', () => {
    const decoder = huggingfaceModule.createDecoder('meta-llama/Llama-3.3-70B-Instruct');
    const events = decoder.feed('{"choices":[{"delta":{"content":"hello"}}]}');
    expect(events[0]).toEqual({ type: 'delta', text: 'hello' });
  });

  it('has an empty static model list (discovered at runtime) and no price table', () => {
    expect(huggingfaceModule.models).toEqual([]);
  });

  it('is registered and resolvable by provider id', () => {
    expect(getProviderModule('huggingface').provider).toBe('huggingface');
    // Cost is $0 against the empty price table — the AI Lab surfaces that as
    // "unknown" (pricingKnown=false), NOT free, so a cost scorer fails cleanly.
    const decoder = huggingfaceModule.createDecoder('any-model');
    decoder.feed(
      JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 100 },
      })
    );
    const usage = decoder.flush().find((e) => e.type === 'usage');
    expect(usage && usage.type === 'usage' && usage.usage.estimatedCostUSD).toBe(0);
  });
});

describe('huggingface type guard', () => {
  it('isHuggingFaceProvider narrows the huggingface provider only', () => {
    expect(isHuggingFaceProvider('huggingface')).toBe(true);
    expect(isHuggingFaceProvider('openai')).toBe(false);
    expect(isHuggingFaceProvider('ollama')).toBe(false);
    expect(isHuggingFaceProvider('openrouter')).toBe(false);
    expect(isHuggingFaceProvider('openai-compatible')).toBe(false);
  });

  it('is included in ALL_PROVIDERS exactly once', () => {
    expect(ALL_PROVIDERS.filter((p) => p === 'huggingface')).toEqual(['huggingface']);
  });
});
