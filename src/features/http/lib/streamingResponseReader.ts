import { SseParser, type SseEvent } from '@shared/protocol/sse-parser';
import { NdjsonParser, type NdjsonValue } from '@shared/protocol/ndjson-parser';

export type StreamFormat = 'sse' | 'ndjson' | 'raw';

export type HttpStreamEvent =
  | { type: 'sse'; payload: SseEvent }
  | { type: 'ndjson'; payload: NdjsonValue }
  | { type: 'raw'; payload: string }
  | { type: 'end'; bytesRead: number; durationMs: number }
  | { type: 'error'; error: string; bytesRead: number };

export function detectStreamFormat(contentType: string | null | undefined): StreamFormat {
  if (!contentType) return 'raw';
  const lower = contentType.toLowerCase();
  if (lower.includes('text/event-stream')) return 'sse';
  if (lower.includes('application/x-ndjson') || lower.includes('application/jsonl')) {
    return 'ndjson';
  }
  return 'raw';
}

export interface ReadStreamingOptions {
  signal?: AbortSignal;
}

/**
 * Consume a Response body as an async iterable of stream events.
 *
 * Format dispatch (by Content-Type):
 *   text/event-stream → 'sse' (SseParser)
 *   application/x-ndjson | application/jsonl → 'ndjson' (NdjsonParser)
 *   any other → 'raw' (UTF-8 decoded chunks)
 *
 * The generator yields format-specific events as the upstream produces them,
 * then a final 'end' event on clean close, or 'error' on read failure.
 *
 * Caller controls early termination via the AbortSignal in options. The
 * generator cancels the underlying ReadableStream reader on abort.
 */
export async function* readStreamingResponse(
  response: Response,
  options: ReadStreamingOptions = {}
): AsyncIterable<HttpStreamEvent> {
  const format = detectStreamFormat(response.headers.get('content-type'));
  const startMs = Date.now();
  let bytesRead = 0;

  if (!response.body) {
    yield { type: 'end', bytesRead: 0, durationMs: Date.now() - startMs };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const sseParser = format === 'sse' ? new SseParser() : null;
  const ndjsonParser = format === 'ndjson' ? new NdjsonParser() : null;

  const onAbort = () => {
    void reader.cancel().catch(() => {
      /* ignore */
    });
  };
  if (options.signal) {
    if (options.signal.aborted) {
      onAbort();
    } else {
      options.signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;

      if (sseParser) {
        for (const event of sseParser.feed(value)) {
          yield { type: 'sse', payload: event };
        }
      } else if (ndjsonParser) {
        for (const payload of ndjsonParser.feed(value)) {
          yield { type: 'ndjson', payload };
        }
      } else {
        yield { type: 'raw', payload: decoder.decode(value, { stream: true }) };
      }
    }

    // Drain any trailing partial events
    if (sseParser) {
      for (const event of sseParser.flush()) {
        yield { type: 'sse', payload: event };
      }
    } else if (ndjsonParser) {
      for (const payload of ndjsonParser.flush()) {
        yield { type: 'ndjson', payload };
      }
    } else {
      const final = decoder.decode();
      if (final) yield { type: 'raw', payload: final };
    }

    yield { type: 'end', bytesRead, durationMs: Date.now() - startMs };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Stream read failed';
    yield { type: 'error', error: message, bytesRead };
  } finally {
    if (options.signal) {
      options.signal.removeEventListener('abort', onAbort);
    }
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}
