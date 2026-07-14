import { describe, expect, it } from 'vitest';
import { PROVIDER_ROUTES } from '../provider-routes';
import type { ChatRequestSpec } from '../types';

function spec(provider: ChatRequestSpec['provider']): ChatRequestSpec {
  return {
    provider,
    model: 'model',
    apiKeyHandleId: '',
    rawMode: true,
    messages: [
      { role: 'user', content: 'lookup' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'lookup', input: '{"id":1}' }],
      },
      { role: 'tool', toolCallId: 'call-1', content: '{"paid":true}' },
    ],
  };
}

describe('agent tool-result provider routes', () => {
  it('encodes OpenAI assistant calls and tool results', () => {
    const body = JSON.parse(PROVIDER_ROUTES.openai.buildRequest(spec('openai'), 'key').body);
    expect(body.messages.slice(1)).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"id":1}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call-1', content: '{"paid":true}' },
    ]);
  });

  it('encodes Anthropic tool_use and tool_result content blocks', () => {
    const body = JSON.parse(PROVIDER_ROUTES.anthropic.buildRequest(spec('anthropic'), 'key').body);
    expect(body.messages.slice(1)).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call-1', name: 'lookup', input: { id: 1 } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-1', content: '{"paid":true}' }],
      },
    ]);
  });
});
