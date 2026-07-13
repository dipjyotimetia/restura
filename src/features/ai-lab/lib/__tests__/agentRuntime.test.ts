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
});
