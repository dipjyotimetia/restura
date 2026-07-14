import { PROVIDER_ROUTES } from '@shared/protocol/ai/provider-routes';
import { getProviderModule } from '@shared/protocol/ai/providers';
import type { ChatRequestSpec } from '@shared/protocol/ai/types';
import { describe, expect, it } from 'vitest';

function spec(over: Partial<ChatRequestSpec> = {}): ChatRequestSpec {
  return {
    provider: 'ollama',
    model: 'llama3.2',
    messages: [{ role: 'user', content: 'hi' }],
    apiKeyHandleId: '',
    rawMode: false,
    ...over,
  };
}

describe('ollama route', () => {
  it('targets the default localhost base and omits Authorization when keyless', () => {
    const built = PROVIDER_ROUTES.ollama.buildRequest(spec(), '');
    expect(built.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(built.headers.Authorization).toBeUndefined();
    const body = JSON.parse(built.body) as { model: string; stream: boolean };
    expect(body.model).toBe('llama3.2');
    expect(body.stream).toBe(true);
  });

  it('honors a base URL override and sends Bearer when a key is supplied', () => {
    const built = PROVIDER_ROUTES.ollama.buildRequest(
      spec({ baseUrlOverride: 'http://10.0.0.5:11434/' }),
      'secret'
    );
    expect(built.url).toBe('http://10.0.0.5:11434/v1/chat/completions');
    expect(built.headers.Authorization).toBe('Bearer secret');
  });
});

describe('openai-compatible route', () => {
  it('uses the user-supplied base URL', () => {
    const built = PROVIDER_ROUTES['openai-compatible'].buildRequest(
      spec({ provider: 'openai-compatible', baseUrlOverride: 'https://api.groq.com/openai' }),
      'gsk-x'
    );
    expect(built.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(built.headers.Authorization).toBe('Bearer gsk-x');
  });
});

describe('provider modules', () => {
  it('expose decoders for the new local providers', () => {
    expect(getProviderModule('ollama').createDecoder('llama3.2')).toBeDefined();
    expect(getProviderModule('openai-compatible').createDecoder('any')).toBeDefined();
  });
});
