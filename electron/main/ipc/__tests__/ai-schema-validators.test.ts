import { describe, it, expect } from 'vitest';
import {
  AiChatRequestSchema,
  AiLabCompleteSchema,
  AiLabCompleteCancelSchema,
  AiLabStreamSchema,
  AiLabDiscoverSchema,
} from '../ipc-validators';

// Shared base for inference specs: fill in provider + apiKeyHandleId per case.
function inferenceSpec(over: Record<string, unknown>): Record<string, unknown> {
  return {
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'hi' }],
    rawMode: true,
    ...over,
  };
}

function completeSpec(over: Record<string, unknown>): Record<string, unknown> {
  return inferenceSpec({ operationId: crypto.randomUUID(), ...over });
}

describe('AiChatRequestSchema — API-key requirement for cloud providers', () => {
  it('accepts a cloud provider WITH an API key handle', () => {
    const r = AiChatRequestSchema.safeParse(
      inferenceSpec({
        streamId: crypto.randomUUID(),
        provider: 'openai',
        apiKeyHandleId: crypto.randomUUID(),
      })
    );
    expect(r.success).toBe(true);
  });

  it.each(['openai', 'anthropic', 'openrouter'])(
    'rejects a cloud provider (%s) WITHOUT an API key handle',
    (provider) => {
      const r = AiChatRequestSchema.safeParse(
        inferenceSpec({ streamId: crypto.randomUUID(), provider })
      );
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.error.issues.some((i) => i.path.includes('apiKeyHandleId'))).toBe(true);
      }
    }
  );

  it('accepts a keyless openai-compatible (local) provider with a base URL', () => {
    const r = AiChatRequestSchema.safeParse(
      inferenceSpec({
        streamId: crypto.randomUUID(),
        provider: 'openai-compatible',
        baseUrlOverride: 'http://localhost:11434',
      })
    );
    expect(r.success).toBe(true);
  });
});

describe('AiLabCompleteSchema / AiLabStreamSchema — API-key requirement', () => {
  it.each(['openai', 'anthropic', 'openrouter', 'huggingface'])(
    'rejects a cloud provider (%s) complete WITHOUT an API key handle',
    (provider) => {
      const r = AiLabCompleteSchema.safeParse(completeSpec({ provider }));
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.error.issues.some((i) => i.path.includes('apiKeyHandleId'))).toBe(true);
      }
    }
  );

  it.each(['openai', 'anthropic', 'openrouter', 'huggingface'])(
    'accepts a cloud provider (%s) complete WITH an API key handle',
    (provider) => {
      const r = AiLabCompleteSchema.safeParse(
        completeSpec({ provider, apiKeyHandleId: crypto.randomUUID() })
      );
      expect(r.success).toBe(true);
    }
  );

  it.each(['ollama', 'openai-compatible'])(
    'accepts a keyless local provider (%s) for complete',
    (provider) => {
      const r = AiLabCompleteSchema.safeParse(
        completeSpec({
          provider,
          ...(provider === 'openai-compatible'
            ? { baseUrlOverride: 'http://localhost:11434' }
            : {}),
        })
      );
      expect(r.success).toBe(true);
    }
  );

  it('rejects a keyless HuggingFace stream call', () => {
    const r = AiLabStreamSchema.safeParse(
      inferenceSpec({ provider: 'huggingface', streamId: crypto.randomUUID() })
    );
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('apiKeyHandleId'))).toBe(true);
    }
  });
});

describe('AiLabCompleteCancelSchema', () => {
  it('rejects a malformed operation ID', () => {
    expect(AiLabCompleteCancelSchema.safeParse({ operationId: 'not-a-uuid' }).success).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(
      AiLabCompleteCancelSchema.safeParse({
        operationId: crypto.randomUUID(),
        unexpected: true,
      }).success
    ).toBe(false);
  });
});

describe('AiLabDiscoverSchema — API-key requirement for discovery', () => {
  it.each(['openai', 'anthropic', 'huggingface'])(
    'rejects a key-required cloud provider (%s) discovery WITHOUT any key',
    (provider) => {
      const r = AiLabDiscoverSchema.safeParse({
        provider,
        baseUrl: 'https://api.openai.com',
      });
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.error.issues.some((i) => i.path.includes('apiKey'))).toBe(true);
      }
    }
  );

  it.each(['openai', 'anthropic', 'huggingface'])(
    'accepts a key-required cloud provider (%s) discovery WITH a plaintext apiKey',
    (provider) => {
      const r = AiLabDiscoverSchema.safeParse({
        provider,
        baseUrl: 'https://api.openai.com',
        apiKey: 'sk-test',
      });
      expect(r.success).toBe(true);
    }
  );

  it.each(['openai', 'anthropic', 'huggingface'])(
    'accepts a key-required cloud provider (%s) discovery WITH an apiKeyHandleId',
    (provider) => {
      const r = AiLabDiscoverSchema.safeParse({
        provider,
        baseUrl: 'https://api.openai.com',
        apiKeyHandleId: crypto.randomUUID(),
      });
      expect(r.success).toBe(true);
    }
  );

  it('accepts OpenRouter discovery WITHOUT a key (public catalog)', () => {
    const r = AiLabDiscoverSchema.safeParse({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api',
    });
    expect(r.success).toBe(true);
  });

  it.each(['ollama', 'openai-compatible'])(
    'accepts a keyless local provider (%s) discovery',
    (provider) => {
      const r = AiLabDiscoverSchema.safeParse({
        provider,
        baseUrl: 'http://localhost:11434',
      });
      expect(r.success).toBe(true);
    }
  );
});
