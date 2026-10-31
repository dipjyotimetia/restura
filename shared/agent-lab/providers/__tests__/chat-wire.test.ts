import type { Fetcher, FetcherResponse } from '@shared/protocol/types';
import { describe, expect, it, vi } from 'vitest';
import { ChatWireProviderAdapter, isChatWireProviderId } from '../chat-wire';

function sse(events: unknown[]): FetcherResponse {
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return {
    status: 200,
    statusText: 'OK',
    headers: {},
    contentLengthHeader: null,
    text: async () => text,
    body: new Response(text).body,
  };
}

const context = (credential = 'key') => ({
  resolveCredential: vi.fn().mockResolvedValue(credential),
});
const request = {
  model: {
    providerId: 'google.generateContent',
    model: 'gemini-x',
    credential: { source: 'env' as const, name: 'GEMINI_API_KEY' },
  },
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
  tools: [{ name: 'lookup', description: 'Look up', inputSchema: { type: 'object' } }],
  maxOutputTokens: 256,
};

describe('ChatWireProviderAdapter (#1044)', () => {
  it('runs Gemini through the shared route and maps tool calls, usage and price overrides', async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(
      sse([
        {
          candidates: [
            {
              content: { parts: [{ functionCall: { name: 'lookup', args: { q: 1 } } }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 1_000_000, candidatesTokenCount: 1_000_000 },
        },
      ])
    );
    const adapter = new ChatWireProviderAdapter({
      id: 'google.generateContent',
      fetcher,
      priceOverrides: { 'gemini-x': { inputUSDPerMTok: 1, outputUSDPerMTok: 2 } },
    });
    const response = await adapter.generate(request, context('g-key'));

    const sent = fetcher.mock.calls[0]![0];
    expect(sent.url).toContain('/v1beta/models/gemini-x:streamGenerateContent');
    expect((sent.headers as Record<string, string>)['x-goog-api-key']).toBe('g-key');
    expect(JSON.parse(String(sent.body)).generationConfig.maxOutputTokens).toBe(256);
    expect(response.toolCalls).toEqual([
      { id: 'gemini-call-1', name: 'lookup', arguments: { q: 1 } },
    ]);
    expect(response.usage).toEqual({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(response.costUSD).toBe(3);
    expect(response.stopReason).toBe('tool-calls');
  });

  it('sends Azure calls to the operator endpoint, and leaves cost unknown without a price', async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(
      sse([
        { choices: [{ delta: { content: 'hello' } }] },
        {
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        },
      ])
    );
    const adapter = new ChatWireProviderAdapter({
      id: 'azure.openai',
      fetcher,
      baseUrl: 'https://acme.openai.azure.com',
    });
    const response = await adapter.generate(
      {
        ...request,
        model: { ...request.model, providerId: 'azure.openai', model: 'my-deployment' },
      },
      context('az-key')
    );
    expect(fetcher.mock.calls[0]![0].url).toBe(
      'https://acme.openai.azure.com/openai/v1/chat/completions'
    );
    expect(response.output).toEqual([{ type: 'text', text: 'hello' }]);
    expect(response.costUSD).toBeUndefined();
  });

  it('refuses to send raw secrets unless the override is set', async () => {
    const fetcher = vi.fn<Fetcher>();
    const adapter = new ChatWireProviderAdapter({ id: 'google.generateContent', fetcher });
    await expect(
      adapter.generate(
        {
          ...request,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'key sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD' },
              ],
            },
          ],
        },
        context()
      )
    ).rejects.toThrow(/raw secrets/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('requires a credential', async () => {
    const adapter = new ChatWireProviderAdapter({ id: 'aws.bedrock.converse', fetcher: vi.fn() });
    await expect(
      adapter.generate(request, { resolveCredential: async () => undefined })
    ).rejects.toThrow(/needs a credential/);
  });

  it('knows its provider ids', () => {
    expect(isChatWireProviderId('aws.bedrock.converse')).toBe(true);
    expect(isChatWireProviderId('openai.responses')).toBe(false);
  });
});
