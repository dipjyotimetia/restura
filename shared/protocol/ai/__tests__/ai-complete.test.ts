import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runToCompletion } from '@shared/protocol/ai/ai-complete';
import type { ChatRequestSpec } from '@shared/protocol/ai/types';
import type { Fetcher, FetcherResponse } from '@shared/protocol/types';
import { describe, expect, it, vi } from 'vitest';

function makeSpec(over: Partial<ChatRequestSpec> = {}): ChatRequestSpec {
  return {
    provider: 'openai',
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'why did this fail?' }],
    apiKeyHandleId: 'handle-xyz',
    rawMode: false,
    ...over,
  };
}

function fixtureStream(filename: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(
    readFileSync(join(__dirname, '..', 'providers', '__fixtures__', filename), 'utf8')
  );
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function fakeFetcher(
  body: ReadableStream<Uint8Array> | null,
  status = 200,
  textBody = ''
): Fetcher {
  return vi.fn(
    async (): Promise<FetcherResponse> => ({
      status,
      statusText: String(status),
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body,
      contentLengthHeader: null,
      text: async () => textBody,
    })
  );
}

describe('runToCompletion', () => {
  it('accumulates deltas into final text and reports ok with usage', async () => {
    const res = await runToCompletion(
      makeSpec(),
      fakeFetcher(fixtureStream('openai-explain.sse.txt')),
      async () => 'sk-fake'
    );
    expect(res.ok).toBe(true);
    expect(res.text).toBe('The request failed.');
    expect(res.error).toBeUndefined();
    expect(res.usage).toBeDefined();
  });

  it('collects tool calls without streaming them', async () => {
    const res = await runToCompletion(
      makeSpec(),
      fakeFetcher(fixtureStream('openai-tool-call.sse.txt')),
      async () => 'sk-fake'
    );
    expect(res.toolCalls.length).toBeGreaterThan(0);
    expect(res.toolCalls[0]?.name).toBeTruthy();
  });

  it('returns ok:false with the error on a non-2xx upstream', async () => {
    const res = await runToCompletion(
      makeSpec(),
      fakeFetcher(fixtureStream('openai-error-429.sse.txt'), 429, '{"error":{"message":"rate"}}'),
      async () => 'sk-fake'
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('provider');
  });

  it('allows a keyless local provider (empty handle id) — no guard error', async () => {
    const res = await runToCompletion(
      makeSpec({ provider: 'ollama', model: 'llama3.2', apiKeyHandleId: '' }),
      fakeFetcher(fixtureStream('openai-explain.sse.txt')),
      async () => undefined
    );
    expect(res.ok).toBe(true);
    expect(res.text).toBe('The request failed.');
  });
});

function textStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

const sse = (data: unknown, event?: string) =>
  `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;

describe('runToCompletion — a stream cut off before the provider finished', () => {
  const anthropicText =
    sse({ type: 'message_start', message: { usage: { input_tokens: 3 } } }, 'message_start') +
    sse(
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial' } },
      'content_block_delta'
    );
  const anthropicTool =
    sse(
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 't1', name: 'f' },
      },
      'content_block_start'
    ) +
    sse(
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"a":' },
      },
      'content_block_delta'
    );
  const openaiTool = sse({
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{"a":' } }],
        },
      },
    ],
  });

  it.each([
    ['anthropic without message_stop', 'anthropic', 'claude-sonnet-4-5', anthropicText],
    ['anthropic mid tool call', 'anthropic', 'claude-sonnet-4-5', anthropicTool],
    [
      'openai without finish_reason or DONE',
      'openai',
      'gpt-4o-mini',
      sse({ choices: [{ delta: { content: 'Partial' } }] }),
    ],
    ['openai mid tool call', 'openai', 'gpt-4o-mini', openaiTool],
    [
      'gemini without finishReason',
      'gemini',
      'gemini-2.5-flash',
      sse({ candidates: [{ content: { parts: [{ text: 'Partial' }] } }] }),
    ],
    ['an empty body', 'openai', 'gpt-4o-mini', ''],
  ] as const)('%s is an error, not a success', async (_label, provider, model, body) => {
    const res = await runToCompletion(
      makeSpec({ provider, model }),
      fakeFetcher(textStream(body)),
      async () => 'sk-fake'
    );
    expect(res.ok).toBe(false);
    expect(res.error?.message).toMatch(/truncated/i);
    // A half-streamed tool call must never be handed on as if complete.
    expect(res.toolCalls).toEqual([]);
  });

  it('an openai stream that ends at finish_reason without DONE still succeeds', async () => {
    const res = await runToCompletion(
      makeSpec(),
      fakeFetcher(
        textStream(
          sse({ choices: [{ delta: { content: 'Hi' } }] }) +
            sse({ choices: [{ delta: {}, finish_reason: 'stop' }] })
        )
      ),
      async () => 'sk-fake'
    );
    expect(res.ok).toBe(true);
    expect(res.text).toBe('Hi');
  });
});
