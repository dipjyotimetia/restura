import { runToCompletion } from '@shared/protocol/ai/ai-complete';
import { executeAiChat } from '@shared/protocol/ai/ai-proxy';
import { listModels } from '@shared/protocol/ai/model-discovery';
import { MAX_RESPONSE_SIZE } from '@shared/protocol/http-proxy';
import type { Fetcher, FetcherResponse } from '@shared/protocol/types';
import { describe, expect, it, vi } from 'vitest';
import type { ChatRequestSpec, ChatStreamEvent } from '../types';

const CHUNK = 1024 * 1024;

/**
 * A hostile endpoint: a body that never ends. The test only terminates when the
 * reader stops pulling at the cap, which is what "bounded memory" means here —
 * a post-read length check would hang (or OOM) on this stream.
 */
function endlessStream(chunk: () => Uint8Array, counters: { pulls: number; cancelled: boolean }) {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      counters.pulls++;
      if (counters.pulls > 200) {
        controller.error(new Error('read was not bounded'));
        return;
      }
      controller.enqueue(chunk());
    },
    cancel() {
      counters.cancelled = true;
    },
  });
}

function fetcherFor(
  body: ReadableStream<Uint8Array>,
  status = 200,
  contentLength: string | null = null
): Fetcher {
  return vi.fn(
    async (): Promise<FetcherResponse> => ({
      status,
      statusText: String(status),
      headers: new Headers(),
      body,
      contentLengthHeader: contentLength,
      // A buffered read of an endless body would never settle.
      text: () => new Promise<string>(() => {}),
    })
  );
}

const spec: ChatRequestSpec = {
  provider: 'ollama',
  model: 'm',
  messages: [{ role: 'user', content: 'hi' }],
  apiKeyHandleId: '',
  rawMode: false,
};

const sseCommentChunk = () => new TextEncoder().encode(`:${'x'.repeat(CHUNK - 4)}\n\n`);
const textChunk = (s: string) => () => new TextEncoder().encode(s.repeat(CHUNK / s.length));

async function drain(fetcher: Fetcher): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const ev of executeAiChat(spec, fetcher, async () => undefined)) events.push(ev);
  return events;
}

describe('AI response size cap (#1032)', () => {
  it('completion stream: stops reading at MAX_RESPONSE_SIZE and fails with a clear error', async () => {
    const counters = { pulls: 0, cancelled: false };
    const events = await drain(fetcherFor(endlessStream(sseCommentChunk, counters)));
    const error = events.find((e) => e.type === 'error');
    expect(error).toMatchObject({ type: 'error' });
    expect((error as { message: string }).message).toMatch(/too large/i);
    expect(counters.pulls).toBeLessThanOrEqual(MAX_RESPONSE_SIZE / CHUNK + 2);
    expect(counters.cancelled).toBe(true);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('runToCompletion surfaces the oversize failure instead of accumulating', async () => {
    const counters = { pulls: 0, cancelled: false };
    const result = await runToCompletion(
      spec,
      fetcherFor(endlessStream(sseCommentChunk, counters)),
      async () => undefined
    );
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/too large/i);
    expect(counters.cancelled).toBe(true);
  });

  it('provider error bodies are truncated, not failed: the real provider error is shown', async () => {
    const counters = { pulls: 0, cancelled: false };
    const first = 'quota exceeded for model m. ';
    let emitted = false;
    const body = endlessStream(() => {
      if (!emitted) {
        emitted = true;
        return new TextEncoder().encode(first + 'y'.repeat(CHUNK));
      }
      return new TextEncoder().encode('y'.repeat(CHUNK));
    }, counters);
    const events = await drain(fetcherFor(body, 429));
    const error = events.find((e) => e.type === 'error') as { code: string; message: string };
    expect(error.code).toBe('provider');
    expect(error.message).toContain('Provider 429: quota exceeded for model m.');
    expect(error.message.length).toBeLessThanOrEqual(600);
    // Bounded: far fewer pulls than the endless stream would allow.
    expect(counters.pulls).toBeLessThan(5);
    expect(counters.cancelled).toBe(true);
  });

  it('model discovery: oversize success body fails with a clear error and bounded reads', async () => {
    const counters = { pulls: 0, cancelled: false };
    await expect(
      listModels({
        provider: 'ollama',
        baseUrl: 'http://localhost:11434',
        fetcher: fetcherFor(endlessStream(textChunk('a'), counters)),
      })
    ).rejects.toThrow(/too large/i);
    expect(counters.pulls).toBeLessThanOrEqual(MAX_RESPONSE_SIZE / CHUNK + 2);
    expect(counters.cancelled).toBe(true);
  });

  it('model discovery: a declared content-length over the cap fails before reading', async () => {
    const counters = { pulls: 0, cancelled: false };
    await expect(
      listModels({
        provider: 'ollama',
        baseUrl: 'http://localhost:11434',
        fetcher: fetcherFor(
          endlessStream(textChunk('a'), counters),
          200,
          String(MAX_RESPONSE_SIZE + 1)
        ),
      })
    ).rejects.toThrow(/too large/i);
    // The stream primes one chunk on construction; nothing is read after that.
    expect(counters.pulls).toBeLessThanOrEqual(1);
  });

  it('model discovery: oversize error body is truncated and the status is still reported', async () => {
    const counters = { pulls: 0, cancelled: false };
    await expect(
      listModels({
        provider: 'ollama',
        baseUrl: 'http://localhost:11434',
        fetcher: fetcherFor(endlessStream(textChunk('e'), counters), 500),
      })
    ).rejects.toThrow(/Model discovery failed \(500\): e+/);
    expect(counters.pulls).toBeLessThan(5);
    expect(counters.cancelled).toBe(true);
  });

  it('still reads normal-sized bodies from text()-only fetchers', async () => {
    const fetcher: Fetcher = async () => ({
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      contentLengthHeader: null,
      text: async () => JSON.stringify({ models: [{ name: 'llama3.2' }] }),
    });
    const models = await listModels({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      fetcher,
    });
    expect(models.map((m) => m.id)).toEqual(['llama3.2']);
  });
});
