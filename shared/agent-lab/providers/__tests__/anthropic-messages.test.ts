import type { Fetcher } from '@shared/protocol/types';
import { describe, expect, it, vi } from 'vitest';
import { AnthropicMessagesAdapter } from '../anthropic-messages';

function fetcher(body: unknown): Fetcher {
  return vi.fn().mockResolvedValue({
    status: 200,
    statusText: 'OK',
    headers: {},
    contentLengthHeader: null,
    text: async () => JSON.stringify(body),
  });
}

describe('AnthropicMessagesAdapter', () => {
  it('uses the native Messages tool wire format and parses a tool call', async () => {
    const transport = fetcher({
      id: 'msg_1',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { id: '42' } }],
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    const adapter = new AnthropicMessagesAdapter({ fetcher: transport });

    const result = await adapter.generate(
      {
        model: {
          providerId: 'anthropic.messages',
          model: 'claude-sonnet',
          credential: { source: 'env', name: 'ANTHROPIC_API_KEY' },
        },
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'Use tools carefully.' }] },
          { role: 'user', content: [{ type: 'text', text: 'Find order 42.' }] },
        ],
        tools: [
          {
            name: 'lookup',
            description: 'Lookup an order',
            inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
          },
        ],
      },
      { resolveCredential: async () => 'test-key' }
    );

    expect(result).toMatchObject({
      id: 'msg_1',
      toolCalls: [{ id: 'toolu_1', name: 'lookup', arguments: { id: '42' } }],
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    const request = JSON.parse(vi.mocked(transport).mock.calls[0]?.[0].body as string);
    expect(request).toMatchObject({
      system: 'Use tools carefully.',
      tools: [{ name: 'lookup', input_schema: expect.any(Object) }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Find order 42.' }] }],
    });
    expect(vi.mocked(transport).mock.calls[0]?.[0].headers).toMatchObject({
      'anthropic-version': '2023-06-01',
      'x-api-key': 'test-key',
    });
  });

  it('replays tool output as an Anthropic tool_result user turn', async () => {
    const transport = fetcher({
      id: 'msg_2',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Found it.' }],
      usage: { input_tokens: 12, output_tokens: 3 },
    });
    const adapter = new AnthropicMessagesAdapter({ fetcher: transport });

    await adapter.generate(
      {
        model: { providerId: 'anthropic.messages', model: 'claude-sonnet' },
        messages: [
          {
            role: 'assistant',
            content: [],
            toolCalls: [{ id: 'toolu_1', name: 'lookup', arguments: { id: '42' } }],
          },
          {
            role: 'tool',
            toolCallId: 'toolu_1',
            content: [{ type: 'json', value: { status: 200 } }],
          },
        ],
      },
      { resolveCredential: async () => undefined }
    );

    const request = JSON.parse(vi.mocked(transport).mock.calls[0]?.[0].body as string);
    expect(request.messages).toEqual([
      expect.objectContaining({
        role: 'assistant',
        content: [expect.objectContaining({ type: 'tool_use' })],
      }),
      expect.objectContaining({
        role: 'user',
        content: [expect.objectContaining({ type: 'tool_result', tool_use_id: 'toolu_1' })],
      }),
    ]);
  });
});
