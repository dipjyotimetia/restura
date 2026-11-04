import { describe, expect, it } from 'vitest';
import { AiChatStateSchema } from '../store-validators';

describe('AiChatStateSchema usage', () => {
  it('keeps "cost unknown" on a reloaded message instead of turning it into $0', () => {
    const parsed = AiChatStateSchema.parse({
      conversations: {
        c1: {
          id: 'c1',
          title: 't',
          createdAt: 1,
          updatedAt: 1,
          messages: [
            {
              id: 'm1',
              role: 'assistant',
              text: 'hi',
              status: 'done',
              createdAt: 1,
              usage: {
                promptTokens: 1,
                completionTokens: 1,
                estimatedCostUSD: 0,
                costUnknown: true,
              },
            },
          ],
        },
      },
      activeConversationId: 'c1',
      panelOpen: false,
      panelWidth: 400,
      providerConfigs: {
        openai: null,
        anthropic: null,
        openrouter: null,
        'openai-compatible': null,
      },
      activeProvider: 'openai',
      redactionMode: 'default',
    });
    expect(parsed.conversations.c1?.messages[0]?.usage?.costUnknown).toBe(true);
  });
});
