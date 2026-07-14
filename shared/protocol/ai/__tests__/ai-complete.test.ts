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
