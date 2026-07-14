import { describe, expect, it } from 'vitest';
import type { Fetcher } from '../../../protocol/types';
import { OpenAiResponsesAdapter } from '../openai-responses';

describe('OpenAiResponsesAdapter', () => {
  it('uses typed Responses input and decodes text, reasoning summaries, tools, and usage', async () => {
    let sentBody = '';
    const fetcher: Fetcher = async (request) => {
      sentBody = typeof request.body === 'string' ? request.body : '';
      return {
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        body: null,
        contentLengthHeader: null,
        async text() {
          return JSON.stringify({
            id: 'resp_1',
            output: [
              { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Checked inputs.' }] },
              { type: 'message', content: [{ type: 'output_text', text: 'Order is paid.' }] },
              {
                type: 'function_call',
                call_id: 'call_1',
                name: 'orders_get',
                arguments: '{"id":42}',
              },
            ],
            usage: { input_tokens: 10, output_tokens: 5 },
            status: 'completed',
          });
        },
      };
    };
    const adapter = new OpenAiResponsesAdapter({ fetcher });

    const response = await adapter.generate(
      {
        model: {
          providerId: 'openai.responses',
          model: 'gpt-test',
          credential: { source: 'env', name: 'OPENAI_API_KEY' },
        },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Check order 42' }] }],
        tools: [
          {
            name: 'orders_get',
            description: 'Get an order',
            inputSchema: { type: 'object', properties: { id: { type: 'number' } } },
          },
        ],
        reasoning: { effort: 'medium', summary: true },
      },
      {
        async resolveCredential() {
          return 'test-key';
        },
      }
    );

    const body = JSON.parse(sentBody) as Record<string, unknown>;
    expect(body.model).toBe('gpt-test');
    expect(body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Check order 42' }] },
    ]);
    expect(body.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
    expect(body.include).toEqual(['reasoning.encrypted_content']);
    expect(response.output).toEqual([
      { type: 'reasoning-summary', text: 'Checked inputs.' },
      { type: 'text', text: 'Order is paid.' },
    ]);
    expect(response.toolCalls).toEqual([
      { id: 'call_1', name: 'orders_get', arguments: { id: 42 } },
    ]);
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(response.providerState).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'reasoning' }),
        expect.objectContaining({ type: 'function_call', call_id: 'call_1' }),
      ])
    );
  });

  it('fails before transport when a credential reference cannot be resolved', async () => {
    const adapter = new OpenAiResponsesAdapter({
      fetcher: async () => {
        throw new Error('must not fetch');
      },
    });

    await expect(
      adapter.generate(
        {
          model: {
            providerId: 'openai.responses',
            model: 'gpt-test',
            credential: { source: 'env', name: 'OPENAI_API_KEY' },
          },
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        },
        {
          async resolveCredential() {
            return undefined;
          },
        }
      )
    ).rejects.toThrow('credential could not be resolved');
  });

  it('serializes multiple tool rounds without persistence or replay ambiguity', async () => {
    let sentBody = '';
    const adapter = new OpenAiResponsesAdapter({
      fetcher: async (request) => {
        sentBody = String(request.body);
        return {
          status: 200,
          statusText: 'OK',
          headers: {},
          body: null,
          contentLengthHeader: null,
          async text() {
            return JSON.stringify({ id: 'resp_2', output: [], status: 'completed' });
          },
        };
      },
    });
    await adapter.generate(
      {
        model: { providerId: 'openai.responses', model: 'gpt-test' },
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'old input' }] },
          {
            role: 'assistant',
            content: [],
            toolCalls: [{ id: 'old-call', name: 'lookup', arguments: {} }],
            providerState: [
              { type: 'reasoning', id: 'reasoning-1', encrypted_content: 'encrypted-1' },
              { type: 'function_call', call_id: 'old-call', name: 'lookup', arguments: '{}' },
            ],
          },
          {
            role: 'tool',
            toolCallId: 'old-call',
            content: [{ type: 'json', value: { old: true } }],
          },
          {
            role: 'assistant',
            content: [],
            toolCalls: [{ id: 'call_1', name: 'lookup', arguments: {} }],
            providerState: [
              { type: 'reasoning', id: 'reasoning-2', encrypted_content: 'encrypted-2' },
              { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{}' },
            ],
          },
          {
            role: 'tool',
            toolCallId: 'call_1',
            content: [{ type: 'json', value: { paid: true } }],
          },
        ],
      },
      {
        async resolveCredential() {
          return undefined;
        },
      }
    );
    const body = JSON.parse(sentBody) as { input: Array<Record<string, unknown>>; store: boolean };
    expect(body.store).toBe(false);
    expect(body.input.filter((item) => item.type === 'function_call_output')).toEqual([
      { type: 'function_call_output', call_id: 'old-call', output: '{"old":true}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"paid":true}' },
    ]);
    expect(body.input.filter((item) => item.type === 'function_call')).toHaveLength(2);
    expect(body.input.filter((item) => item.type === 'reasoning')).toEqual([
      { type: 'reasoning', id: 'reasoning-1', encrypted_content: 'encrypted-1' },
      { type: 'reasoning', id: 'reasoning-2', encrypted_content: 'encrypted-2' },
    ]);
    expect(body.input).not.toContainEqual({ role: 'assistant', content: [] });
  });

  it('classifies common Responses models conservatively and normalizes audio formats', async () => {
    let sentBody = '';
    const adapter = new OpenAiResponsesAdapter({
      fetcher: async (request) => ({
        status: 200,
        statusText: 'OK',
        headers: {},
        body: null,
        contentLengthHeader: null,
        async text() {
          sentBody = String(request.body);
          return JSON.stringify({ id: 'r', output: [] });
        },
      }),
    });
    expect((await adapter.getCapabilities('gpt-4o-mini')).toolCalling).toBe(true);
    expect((await adapter.getCapabilities('gpt-4o-mini')).inputModalities).not.toContain('audio');
    expect((await adapter.getCapabilities('o3')).inputModalities).toEqual(['text']);
    expect((await adapter.getCapabilities('text-embedding-3-small')).toolCalling).toBe(false);
    await adapter.generate(
      {
        model: { providerId: 'openai.responses', model: 'gpt-4o-mini' },
        messages: [
          { role: 'user', content: [{ type: 'audio', mimeType: 'audio/mpeg', data: 'base64' }] },
        ],
      },
      {
        async resolveCredential() {
          return undefined;
        },
      }
    );
    expect(JSON.parse(sentBody).input[0].content[0].input_audio.format).toBe('mp3');
  });

  it('authenticates model discovery through a credential reference', async () => {
    let authorization: string | undefined;
    const adapter = new OpenAiResponsesAdapter({
      discoveryCredential: { source: 'env', name: 'OPENAI_API_KEY' },
      fetcher: async (request) => {
        authorization = (request.headers as Record<string, string>).Authorization;
        return {
          status: 200,
          statusText: 'OK',
          headers: {},
          body: null,
          contentLengthHeader: null,
          async text() {
            return JSON.stringify({ data: [{ id: 'gpt-test' }] });
          },
        };
      },
    });
    const models = await adapter.discoverModels({
      async resolveCredential() {
        return 'secret';
      },
    });
    expect(authorization).toBe('Bearer secret');
    expect(models[0]?.id).toBe('gpt-test');
  });

  it('serializes every supported content form and structured-output control', async () => {
    let sentBody: Record<string, unknown> = {};
    const adapter = new OpenAiResponsesAdapter({
      baseUrl: 'https://gateway.example///',
      fetcher: async (request) => {
        sentBody = JSON.parse(String(request.body));
        return {
          status: 200,
          statusText: 'OK',
          headers: {},
          body: null,
          contentLengthHeader: null,
          async text() {
            return JSON.stringify({
              id: 'response',
              status: 'incomplete',
              output: [
                {
                  type: 'message',
                  content: [
                    { type: 'refusal', refusal: 'cannot comply' },
                    { type: 'ignored', text: 'ignored' },
                  ],
                },
                { type: 'function_call', id: 'fallback-id', name: 'invalid', arguments: '{' },
                { type: 'function_call', name: 'generated-id', arguments: { raw: true } },
              ],
              usage: { input_tokens: 'unknown', output_tokens: 4 },
            });
          },
        };
      },
    });

    const result = await adapter.generate(
      {
        model: {
          providerId: 'openai.responses',
          model: 'gpt-5',
          baseUrl: 'https://override.example/',
        },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', mimeType: 'image/png', uri: 'https://image.example/a.png' },
              { type: 'image', mimeType: 'image/png', data: 'image-data' },
              {
                type: 'document',
                mimeType: 'application/pdf',
                uri: 'https://docs.example/a.pdf',
              },
              {
                type: 'document',
                mimeType: 'application/pdf',
                data: 'document-data',
                name: 'brief.pdf',
              },
              { type: 'json', value: { value: 1 } },
              { type: 'artifact', artifactId: 'artifact-1' },
              { type: 'refusal', reason: 'source refusal' },
              { type: 'reasoning-summary', text: 'summary' },
            ],
          },
          {
            role: 'assistant',
            content: [],
            toolCalls: [{ id: 'tool', name: 'lookup', arguments: 'raw-arguments' }],
          },
          {
            role: 'tool',
            toolCallId: 'tool',
            content: [
              { type: 'text', text: 'text result' },
              { type: 'reasoning-summary', text: 'tool summary' },
              { type: 'artifact', artifactId: 'tool-artifact' },
            ],
          },
        ],
        structuredOutput: { type: 'object' },
        reasoning: { effort: 'low', summary: false },
        maxOutputTokens: 12,
      },
      { async resolveCredential() {} }
    );

    expect(sentBody).toMatchObject({
      model: 'gpt-5',
      text: { format: { type: 'json_schema', name: 'response' } },
      reasoning: { effort: 'low' },
      max_output_tokens: 12,
      store: false,
    });
    expect(JSON.stringify(sentBody)).toContain('data:image/png;base64,image-data');
    expect(JSON.stringify(sentBody)).toContain('brief.pdf');
    expect(result.output).toEqual([{ type: 'refusal', reason: 'cannot comply' }]);
    expect(result.toolCalls[0]).toEqual({
      id: 'fallback-id',
      name: 'invalid',
      arguments: '{',
    });
    expect(result.toolCalls[1]?.id).toMatch(/[0-9a-f-]{36}/i);
    expect(result.usage).toBeUndefined();
    expect(result.stopReason).toBe('tool-calls');
  });

  it.each([
    [
      'continuation id',
      {
        continuationId: 'server-state',
        messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
      },
      /continuation IDs are disabled/,
    ],
    [
      'missing audio data',
      {
        messages: [
          {
            role: 'user' as const,
            content: [
              {
                type: 'audio' as const,
                mimeType: 'audio/wav',
                uri: 'https://audio.example/a.wav',
              },
            ],
          },
        ],
      },
      /requires base64 data/,
    ],
    [
      'unsupported audio format',
      {
        messages: [
          {
            role: 'user' as const,
            content: [{ type: 'audio' as const, mimeType: 'audio/ogg', data: 'data' }],
          },
        ],
      },
      /does not support audio MIME type/,
    ],
  ])('rejects %s before transport', async (_label, patch, error) => {
    const adapter = new OpenAiResponsesAdapter({
      fetcher: async () => {
        throw new Error('must not fetch');
      },
    });
    await expect(
      adapter.generate(
        {
          model: { providerId: 'openai.responses', model: 'gpt-5' },
          ...patch,
        },
        { async resolveCredential() {} }
      )
    ).rejects.toThrow(error);
  });

  it('fails closed on discovery auth, status, invalid entries, and invalid responses', async () => {
    const unresolved = new OpenAiResponsesAdapter({
      discoveryCredential: { source: 'env', name: 'OPENAI_API_KEY' },
      fetcher: async () => {
        throw new Error('must not fetch');
      },
    });
    await expect(unresolved.discoverModels()).rejects.toThrow(/credential could not be resolved/);

    const failedDiscovery = new OpenAiResponsesAdapter({
      fetcher: async () => ({
        status: 503,
        statusText: 'Unavailable',
        headers: {},
        body: null,
        contentLengthHeader: null,
        async text() {
          return '{}';
        },
      }),
    });
    await expect(failedDiscovery.discoverModels()).rejects.toThrow(/status 503/);

    const filteredDiscovery = new OpenAiResponsesAdapter({
      fetcher: async () => ({
        status: 200,
        statusText: 'OK',
        headers: {},
        body: null,
        contentLengthHeader: null,
        async text() {
          return JSON.stringify({ data: [{ id: 'gpt-5' }, { id: 123 }, {}] });
        },
      }),
    });
    await expect(filteredDiscovery.discoverModels()).resolves.toHaveLength(1);

    const invalidResponse = new OpenAiResponsesAdapter({
      fetcher: async () => ({
        status: 200,
        statusText: 'OK',
        headers: {},
        body: null,
        contentLengthHeader: null,
        async text() {
          return JSON.stringify({ id: 123, output: null });
        },
      }),
    });
    await expect(
      invalidResponse.generate(
        {
          model: { providerId: 'openai.responses', model: 'gpt-5' },
          messages: [],
        },
        { async resolveCredential() {} }
      )
    ).rejects.toThrow(/invalid response shape/);
  });

  it('reports provider error bodies and max-token completion without tool calls', async () => {
    let fail = true;
    const adapter = new OpenAiResponsesAdapter({
      fetcher: async () => ({
        status: fail ? 429 : 200,
        statusText: fail ? 'Too Many Requests' : 'OK',
        headers: {},
        body: null,
        contentLengthHeader: null,
        async text() {
          return fail
            ? 'rate limited'
            : JSON.stringify({ id: 'done', output: [], status: 'incomplete' });
        },
      }),
    });
    const request = {
      model: { providerId: 'openai.responses', model: 'gpt-5' },
      messages: [],
    };
    await expect(adapter.generate(request, { async resolveCredential() {} })).rejects.toThrow(
      /429: rate limited/
    );
    fail = false;
    await expect(
      adapter.generate(request, { async resolveCredential() {} })
    ).resolves.toMatchObject({ stopReason: 'max-tokens' });
  });
});
