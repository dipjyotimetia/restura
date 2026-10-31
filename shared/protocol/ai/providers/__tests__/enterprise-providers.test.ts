import { executeAiChat } from '@shared/protocol/ai/ai-proxy';
import { PROVIDER_ROUTES } from '@shared/protocol/ai/provider-routes';
import { getProviderModule } from '@shared/protocol/ai/providers';
import {
  bedrockRegionFromUrl,
  parseBedrockIamCredentials,
} from '@shared/protocol/ai/providers/bedrock';
import type { ChatRequestSpec, ChatStreamEvent } from '@shared/protocol/ai/types';
import { hasStaticPricing } from '@shared/protocol/ai/types';
import type { Fetcher } from '@shared/protocol/types';
import { describe, expect, it, vi } from 'vitest';

function spec(provider: ChatRequestSpec['provider'], overrides: Partial<ChatRequestSpec> = {}) {
  return {
    provider,
    model: 'm',
    apiKeyHandleId: 'h',
    rawMode: true,
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Weather?' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'get_weather', input: '{"city":"Rome"}' }],
      },
      { role: 'tool', toolCallId: 'call-1', content: 'sunny' },
    ],
    tools: [{ name: 'get_weather', description: 'Weather', inputSchema: { type: 'object' } }],
    ...overrides,
  } as ChatRequestSpec;
}

function decode(provider: ChatRequestSpec['provider'], chunks: string[]): ChatStreamEvent[] {
  const decoder = getProviderModule(provider).createDecoder('m');
  return [...chunks.flatMap((chunk) => decoder.feed(chunk)), ...decoder.flush()];
}

describe('Azure OpenAI route (#1044)', () => {
  it('posts OpenAI chat completions to the v1 API with an api-key header', () => {
    const built = PROVIDER_ROUTES['azure-openai'].buildRequest(
      spec('azure-openai', { baseUrlOverride: 'https://acme.openai.azure.com/' }),
      'az-key'
    );
    expect(built.url).toBe('https://acme.openai.azure.com/openai/v1/chat/completions');
    expect(built.headers['api-key']).toBe('az-key');
    expect(built.headers.Authorization).toBeUndefined();
    const body = JSON.parse(built.body);
    expect(body.model).toBe('m');
    expect(body.messages[2].tool_calls[0].function.name).toBe('get_weather');
  });

  it('decodes with the OpenAI decoder', () => {
    const events = decode('azure-openai', [
      JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
      JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }),
    ]);
    expect(events).toContainEqual({ type: 'delta', text: 'hi' });
    expect(events.at(-1)).toEqual({ type: 'done' });
  });
});

describe('Gemini route (#1044)', () => {
  it('maps turns, tool results by name and keeps the key out of the URL', () => {
    const built = PROVIDER_ROUTES.gemini.buildRequest(
      spec('gemini', { model: 'gemini-x' }),
      'g-key'
    );
    expect(built.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-x:streamGenerateContent?alt=sse'
    );
    expect(built.url).not.toContain('g-key');
    expect(built.headers['x-goog-api-key']).toBe('g-key');
    const body = JSON.parse(built.body);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'Be brief.' }] });
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'Weather?' }] },
      { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Rome' } } }] },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'get_weather', response: { content: 'sunny' } } }],
      },
    ]);
    expect(body.tools[0].functionDeclarations[0]).toMatchObject({
      name: 'get_weather',
      parametersJsonSchema: { type: 'object' },
    });
  });

  it('decodes text, function calls and usage, and skips thought parts', () => {
    const events = decode('gemini', [
      JSON.stringify({
        candidates: [
          { content: { parts: [{ text: 'thinking', thought: true }, { text: 'It is ' }] } },
        ],
      }),
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: 'sunny' }, { functionCall: { name: 'log', args: { a: 1 } } }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 2 },
      }),
    ]);
    expect(events).toEqual([
      { type: 'delta', text: 'It is ' },
      { type: 'delta', text: 'sunny' },
      { type: 'tool_call', id: 'gemini-call-1', name: 'log', input: '{"a":1}' },
      { type: 'usage', usage: { promptTokens: 10, completionTokens: 6, estimatedCostUSD: 0 } },
      { type: 'done' },
    ]);
  });

  it('surfaces a blocked prompt as a provider error', () => {
    const events = decode('gemini', [
      JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }),
    ]);
    expect(events[0]).toMatchObject({ type: 'error', message: expect.stringContaining('SAFETY') });
  });
});

describe('Bedrock Converse route (#1044)', () => {
  it('uses a Bedrock API key as a Bearer token and merges tool results into user turns', async () => {
    const route = PROVIDER_ROUTES.bedrock;
    const built = route.buildRequest(
      spec('bedrock', { model: 'anthropic.claude-x-v1:0' }),
      'bedrock-api-key'
    );
    expect(built.url).toBe(
      'https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-x-v1%3A0/converse'
    );
    expect(built.headers.Authorization).toBe('Bearer bedrock-api-key');
    expect(await route.sign!(built, 'bedrock-api-key', {})).toBe(built);
    const body = JSON.parse(built.body);
    expect(body.system).toEqual([{ text: 'Be brief.' }]);
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
    expect(body.messages[2].content[0].toolResult).toEqual({
      toolUseId: 'call-1',
      content: [{ text: 'sunny' }],
    });
    expect(body.toolConfig.tools[0].toolSpec.inputSchema).toEqual({ json: { type: 'object' } });
  });

  it('signs IAM credentials with SigV4 (region from the host, session token included)', async () => {
    const route = PROVIDER_ROUTES.bedrock;
    const secret = JSON.stringify({
      accessKeyId: 'AKID',
      secretAccessKey: 'SECRET',
      sessionToken: 'TOKEN',
    });
    const built = route.buildRequest(
      spec('bedrock', { baseUrlOverride: 'https://bedrock-runtime.eu-west-1.amazonaws.com' }),
      secret
    );
    expect(built.headers.Authorization).toBeUndefined();
    const awsSigner = vi.fn().mockResolvedValue({ Authorization: 'AWS4-HMAC-SHA256 …' });
    const signed = await route.sign!(built, secret, { awsSigner });
    expect(awsSigner).toHaveBeenCalledWith(
      expect.objectContaining({ body: built.body }),
      expect.objectContaining({ region: 'eu-west-1', service: 'bedrock', sessionToken: 'TOKEN' })
    );
    expect(signed.headers.Authorization).toBe('AWS4-HMAC-SHA256 …');

    const builtIn = await route.sign!(built, secret, {});
    expect(builtIn.headers.Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/eu-west-1\/bedrock\/aws4_request, SignedHeaders=[^,]*x-amz-security-token/
    );
    expect(builtIn.headers['X-Amz-Security-Token']).toBe('TOKEN');
  });

  it('refuses IAM signing against a non-Bedrock host', async () => {
    const secret = JSON.stringify({ accessKeyId: 'AKID', secretAccessKey: 'SECRET' });
    const route = PROVIDER_ROUTES.bedrock;
    const built = route.buildRequest(
      spec('bedrock', { baseUrlOverride: 'https://gateway.example' }),
      secret
    );
    await expect(route.sign!(built, secret, {})).rejects.toThrow(/bedrock-runtime/);
  });

  it('parses credentials and regions strictly', () => {
    expect(parseBedrockIamCredentials('plain-key')).toBeUndefined();
    expect(() => parseBedrockIamCredentials('{"accessKeyId":"a"}')).toThrow(/secretAccessKey/);
    expect(bedrockRegionFromUrl('https://bedrock-runtime-fips.us-gov-west-1.amazonaws.com')).toBe(
      'us-gov-west-1'
    );
    expect(bedrockRegionFromUrl('https://bedrock-runtime.evil.example')).toBeUndefined();
  });

  it('decodes a whole Converse body through executeAiChat (json mode, cache tokens in prompt)', async () => {
    const converse = {
      output: {
        message: {
          content: [
            { text: 'Checking.' },
            { toolUse: { toolUseId: 'tu-1', name: 'get_weather', input: { city: 'Rome' } } },
          ],
        },
      },
      stopReason: 'tool_use',
      usage: { inputTokens: 5, outputTokens: 7, cacheReadInputTokens: 3 },
    };
    const text = JSON.stringify(converse);
    const fetcher = vi.fn<Fetcher>().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: {},
      contentLengthHeader: String(text.length),
      text: async () => text,
    });
    const events: ChatStreamEvent[] = [];
    for await (const ev of executeAiChat(spec('bedrock'), fetcher, async () => 'bedrock-api-key')) {
      events.push(ev);
    }
    expect(events).toEqual([
      { type: 'delta', text: 'Checking.' },
      { type: 'tool_call', id: 'tu-1', name: 'get_weather', input: '{"city":"Rome"}' },
      {
        type: 'usage',
        usage: { promptTokens: 8, completionTokens: 7, cacheReadTokens: 3, estimatedCostUSD: 0 },
      },
      { type: 'done' },
    ]);
  });
});

describe('enterprise provider pricing (#1044)', () => {
  it('reads cost as unknown for providers without a static price table', () => {
    expect(hasStaticPricing('openai')).toBe(true);
    for (const provider of [
      'azure-openai',
      'gemini',
      'bedrock',
      'huggingface',
      'ollama',
    ] as const) {
      expect(hasStaticPricing(provider)).toBe(false);
    }
  });
});
