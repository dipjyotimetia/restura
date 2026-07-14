import { describe, expect, it, vi } from 'vitest';
import { CallbackProviderAdapter, STANDARD_PROVIDER_PROFILES } from '../callback';

describe('CallbackProviderAdapter', () => {
  it('keeps provider identifiers open and delegates transport', async () => {
    const generate = vi.fn(async () => ({ id: '1', output: [], toolCalls: [] }));
    const adapter = new CallbackProviderAdapter({
      id: 'company.gateway',
      capabilities: { ...STANDARD_PROVIDER_PROFILES['openai.chat'], serverTools: [] },
      generate,
    });
    await adapter.generate(
      {
        model: { providerId: 'company.gateway', model: 'custom' },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      },
      {
        async resolveCredential() {
          return undefined;
        },
      }
    );
    expect(adapter.id).toBe('company.gateway');
    expect(generate).toHaveBeenCalledOnce();
  });

  it('publishes capability profiles for first-class and gateway providers', () => {
    expect(Object.keys(STANDARD_PROVIDER_PROFILES)).toEqual(
      expect.arrayContaining([
        'openai.responses',
        'openai.chat',
        'anthropic.messages',
        'google.generateContent',
        'azure.openai',
        'aws.bedrock.converse',
        'openrouter',
        'ollama',
        'huggingface',
        'openai.compatible',
      ])
    );
    expect(STANDARD_PROVIDER_PROFILES['anthropic.messages']?.toolCalling).toBe(true);
    expect(STANDARD_PROVIDER_PROFILES['google.generateContent']?.inputModalities).toEqual(['text']);
  });
});
