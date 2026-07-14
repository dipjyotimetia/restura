import { describe, expect, it } from 'vitest';
import {
  detectStreamFormat,
  type HttpStreamEvent,
  readStreamingResponse,
} from '../streamingResponseReader';

const enc = (s: string) => new TextEncoder().encode(s);

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++]!);
      } else {
        controller.close();
      }
    },
  });
}

function makeResponse(body: ReadableStream<Uint8Array>, contentType: string): Response {
  return new Response(body, { headers: { 'content-type': contentType } });
}

async function collect(iter: AsyncIterable<HttpStreamEvent>): Promise<HttpStreamEvent[]> {
  const out: HttpStreamEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

describe('detectStreamFormat', () => {
  it('returns "sse" for text/event-stream', () => {
    expect(detectStreamFormat('text/event-stream')).toBe('sse');
    expect(detectStreamFormat('text/event-stream; charset=utf-8')).toBe('sse');
  });
  it('returns "ndjson" for application/x-ndjson and application/jsonl', () => {
    expect(detectStreamFormat('application/x-ndjson')).toBe('ndjson');
    expect(detectStreamFormat('application/jsonl')).toBe('ndjson');
    expect(detectStreamFormat('application/x-ndjson; charset=utf-8')).toBe('ndjson');
  });
  it('returns "raw" for application/json (buffered, but if the caller passed it here we treat as raw)', () => {
    expect(detectStreamFormat('application/json')).toBe('raw');
  });
  it('returns "raw" for null/undefined/empty content-type', () => {
    expect(detectStreamFormat(null)).toBe('raw');
    expect(detectStreamFormat(undefined)).toBe('raw');
    expect(detectStreamFormat('')).toBe('raw');
  });
});

describe('readStreamingResponse — SSE', () => {
  it('emits sse events as they arrive', async () => {
    const body = streamFromChunks([enc('data: a\n\n'), enc('data: b\n\n')]);
    const response = makeResponse(body, 'text/event-stream');
    const events = await collect(readStreamingResponse(response));
    expect(events.filter((e) => e.type === 'sse')).toHaveLength(2);
    const datas = events
      .filter((e): e is Extract<HttpStreamEvent, { type: 'sse' }> => e.type === 'sse')
      .map((e) => e.payload.data);
    expect(datas).toEqual(['a', 'b']);
    const last = events[events.length - 1];
    expect(last?.type).toBe('end');
  });

  it('emits trailing partial event on flush', async () => {
    const body = streamFromChunks([enc('data: a\n\ndata: trailing')]);
    const response = makeResponse(body, 'text/event-stream');
    const events = await collect(readStreamingResponse(response));
    const sseEvents = events.filter(
      (e): e is Extract<HttpStreamEvent, { type: 'sse' }> => e.type === 'sse'
    );
    expect(sseEvents.map((e) => e.payload.data)).toEqual(['a', 'trailing']);
  });
});

describe('readStreamingResponse — NDJSON', () => {
  it('emits ndjson values as they arrive', async () => {
    const body = streamFromChunks([enc('{"a":1}\n{"b":2}\n'), enc('{"c":3}\n')]);
    const response = makeResponse(body, 'application/x-ndjson');
    const events = await collect(readStreamingResponse(response));
    const ndjson = events
      .filter((e): e is Extract<HttpStreamEvent, { type: 'ndjson' }> => e.type === 'ndjson')
      .map((e) => e.payload);
    expect(ndjson).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it('emits parseError sentinel for malformed lines without aborting', async () => {
    const body = streamFromChunks([enc('{"a":1}\n{bad}\n{"c":3}\n')]);
    const response = makeResponse(body, 'application/x-ndjson');
    const events = await collect(readStreamingResponse(response));
    const ndjson = events.filter(
      (e): e is Extract<HttpStreamEvent, { type: 'ndjson' }> => e.type === 'ndjson'
    );
    expect(ndjson).toHaveLength(3);
    expect(ndjson[0]?.payload).toEqual({ a: 1 });
    expect(ndjson[1]?.payload).toMatchObject({ __parseError: '{bad}' });
    expect(ndjson[2]?.payload).toEqual({ c: 3 });
  });
});

describe('readStreamingResponse — raw', () => {
  it('emits decoded chunks as raw events', async () => {
    const body = streamFromChunks([enc('hello '), enc('world\n')]);
    const response = makeResponse(body, 'text/plain');
    const events = await collect(readStreamingResponse(response));
    const raw = events
      .filter((e): e is Extract<HttpStreamEvent, { type: 'raw' }> => e.type === 'raw')
      .map((e) => e.payload);
    expect(raw.join('')).toBe('hello world\n');
  });
});

describe('readStreamingResponse — lifecycle', () => {
  it('emits an end event with bytesRead and durationMs', async () => {
    const body = streamFromChunks([enc('hello')]);
    const response = makeResponse(body, 'text/plain');
    const events = await collect(readStreamingResponse(response));
    const last = events[events.length - 1];
    expect(last?.type).toBe('end');
    if (last?.type === 'end') {
      expect(last.bytesRead).toBe(5);
      expect(last.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('emits an error event when the stream errors', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('upstream gone'));
      },
    });
    const response = makeResponse(body, 'text/event-stream');
    const events = await collect(readStreamingResponse(response));
    const last = events[events.length - 1];
    expect(last?.type).toBe('error');
    if (last?.type === 'error') {
      expect(last.error).toMatch(/upstream gone/);
    }
  });

  it('cancels the stream when signal aborts', async () => {
    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(enc('data: x\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = makeResponse(body, 'text/event-stream');
    const iter = readStreamingResponse(response, { signal: controller.signal });
    const reader = iter[Symbol.asyncIterator]();
    await reader.next(); // consume one event so the pull starts
    controller.abort();
    // Drain the iterator
    while (!(await reader.next()).done) {
      /* drain */
    }
    // The cancel handler may run async — give it a microtask
    await Promise.resolve();
    expect(cancelled).toBe(true);
  });

  it('returns "raw" when response has no body', async () => {
    const response = new Response(null, { headers: { 'content-type': 'text/plain' } });
    const events = await collect(readStreamingResponse(response));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('end');
  });
});
