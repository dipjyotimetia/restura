import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { executeAiChat } from '@shared/protocol/ai/ai-proxy';
import type { ChatRequestSpec, ChatStreamEvent } from '@shared/protocol/ai/types';
import type { Fetcher, FetcherRequest, FetcherResponse } from '@shared/protocol/types';

function makeSpec(over: Partial<ChatRequestSpec> = {}): ChatRequestSpec {
  return {
    provider: 'openai',
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You explain HTTP responses.' },
      { role: 'user', content: 'why did this fail?' },
    ],
    apiKeyHandleId: 'handle-xyz',
    rawMode: false,
    ...over,
  };
}

function fixtureStream(filename: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(
    readFileSync(join(__dirname, '..', 'providers', '__fixtures__', filename), 'utf8'),
  );
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function fakeFetcher(body: ReadableStream<Uint8Array>, status = 200, textBody = ''): Fetcher {
  return vi.fn(async (_req: FetcherRequest): Promise<FetcherResponse> => ({
    status,
    statusText: String(status),
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body,
    contentLengthHeader: null,
    text: async () => textBody,
  }));
}

const NO_KEY = Symbol('no-key');

async function collect(
  spec: ChatRequestSpec,
  fetcher: Fetcher,
  apiKey: string | undefined | typeof NO_KEY = 'sk-fake',
): Promise<ChatStreamEvent[]> {
  // A default param applies when the arg is `undefined`, which would defeat the
  // "handle cannot be resolved" case. Use a sentinel so an explicit `undefined`
  // resolves to `undefined` (handle not found) rather than the fallback key.
  const resolved = apiKey === NO_KEY ? undefined : apiKey;
  const events: ChatStreamEvent[] = [];
  for await (const ev of executeAiChat(spec, fetcher, async () => resolved)) events.push(ev);
  return events;
}

describe('executeAiChat', () => {
  it('streams deltas, usage, and done for a happy-path OpenAI call', async () => {
    const events = await collect(makeSpec(), fakeFetcher(fixtureStream('openai-explain.sse.txt')));
    const text = events.filter((e): e is Extract<ChatStreamEvent, { type: 'delta' }> => e.type === 'delta').map((e) => e.text).join('');
    expect(text).toBe('The request failed.');
    expect(events.at(-1)?.type).toBe('done');
  });

  it('attaches the resolved API key to the upstream Authorization header', async () => {
    const fetcher = fakeFetcher(fixtureStream('openai-explain.sse.txt'));
    await collect(makeSpec(), fetcher, 'sk-real-key');
    const call = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0];
    const req = call?.[0] as FetcherRequest;
    expect((req.headers as Record<string, string>).Authorization).toBe('Bearer sk-real-key');
  });

  it('rejects with code: guard when messages contain Bearer sk- and rawMode is false', async () => {
    const spec = makeSpec({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'Curl -H "Authorization: Bearer sk-totallyrealtoken1234" foo' },
      ],
    });
    const events = await collect(spec, fakeFetcher(fixtureStream('openai-explain.sse.txt')));
    const guardError = events.find((e): e is Extract<ChatStreamEvent, { type: 'error' }> => e.type === 'error' && e.code === 'guard');
    expect(guardError).toBeDefined();
  });

  it('allows unredacted content when rawMode is true', async () => {
    const spec = makeSpec({
      rawMode: true,
      messages: [{ role: 'user', content: 'Authorization: Bearer sk-realtoken12345678' }],
    });
    const events = await collect(spec, fakeFetcher(fixtureStream('openai-explain.sse.txt')));
    expect(events.some((e) => e.type === 'error' && (e as { code: string }).code === 'guard')).toBe(false);
  });

  it('emits a guard error when the API key handle cannot be resolved', async () => {
    const events = await collect(makeSpec(), fakeFetcher(fixtureStream('openai-explain.sse.txt')), NO_KEY);
    const err = events.find((e): e is Extract<ChatStreamEvent, { type: 'error' }> => e.type === 'error');
    expect(err?.code).toBe('guard');
  });

  it('emits a provider error event on non-2xx upstream', async () => {
    const events = await collect(makeSpec(), fakeFetcher(fixtureStream('openai-error-429.sse.txt'), 429, '{"error":{"message":"rate"}}'));
    const err = events.find((e): e is Extract<ChatStreamEvent, { type: 'error' }> => e.type === 'error');
    expect(err?.code).toBe('provider');
  });
});
