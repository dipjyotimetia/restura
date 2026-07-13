import { describe, expect, it } from 'vitest';
import { createDesktopAgentProviders } from '../agentRuntime';

describe('desktop agent provider bridge', () => {
  it('adapts existing keychain-backed AI Lab providers to the shared runner', async () => {
    const registry = createDesktopAgentProviders(
      {
        cfg: {
          id: 'cfg',
          provider: 'anthropic',
          label: 'Claude',
          pricingKnown: true,
          isLocal: false,
          models: ['claude'],
          createdAt: 0,
          apiKeyHandleId: 'handle',
        },
      },
      async () => ({
        ok: true,
        text: 'done',
        toolCalls: [{ id: 'call', name: 'lookup', input: '{"id":1}' }],
        usage: { promptTokens: 3, completionTokens: 2, estimatedCostUSD: 0.01 },
      })
    );
    const response = await registry.require('cfg').generate(
      {
        model: { providerId: 'cfg', model: 'claude' },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      },
      {
        async resolveCredential() {
          return undefined;
        },
      }
    );
    expect(response).toMatchObject({
      output: [{ type: 'text', text: 'done' }],
      toolCalls: [{ name: 'lookup', arguments: { id: 1 } }],
    });
  });

  it('exposes conservative capabilities for unknown models', async () => {
    const registry = createDesktopAgentProviders({
      cfg: {
        id: 'cfg',
        provider: 'openai-compatible',
        label: 'Gateway',
        pricingKnown: false,
        isLocal: true,
        models: ['custom'],
        createdAt: 0,
      },
    });

    await expect(registry.require('cfg').getCapabilities('custom')).resolves.toMatchObject({
      inputModalities: ['text'],
      toolCalling: false,
      structuredOutput: false,
      reasoning: false,
      continuation: false,
    });
  });

  it('omits cost when the selected model has no exact known pricing', async () => {
    const registry = createDesktopAgentProviders(
      {
        cfg: {
          id: 'cfg',
          provider: 'openai-compatible',
          label: 'Gateway',
          pricingKnown: false,
          isLocal: true,
          models: ['custom'],
          createdAt: 0,
        },
      },
      async () => ({
        ok: true,
        text: 'done',
        toolCalls: [],
        usage: { promptTokens: 3, completionTokens: 2, estimatedCostUSD: 0 },
      })
    );

    const response = await registry.require('cfg').generate(
      {
        model: { providerId: 'cfg', model: 'custom' },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      },
      {
        async resolveCredential() {
          return undefined;
        },
      }
    );

    expect(response.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
    expect(response.costUSD).toBeUndefined();
  });
});
