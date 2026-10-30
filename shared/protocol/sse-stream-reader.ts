/**
 * Compatibility wrapper around the canonical frame parser in `./sse-parser`.
 * Exposes the string-based `feed(chunk, callback)` API (event defaults to
 * "message", `lastEventId` carried across events per the W3C spec, plus
 * `reset()` / `getLastEventId()`) that the renderer SSE feature and the
 * Electron sse/mcp handlers both rely on. Defined once here so the two
 * backend shims don't duplicate the carry logic.
 *
 * TODO(plan: 2026-05-09-streaming-and-h2): once consumers migrate to the
 * frame parser's `feed(Uint8Array): SseEvent[]` API directly, delete this shim.
 */

import {
  type DispatchedSseEvent,
  type ParsedSseEvent,
  SseParser as SseFrameParser,
} from './sse-parser';

export type { ParsedSseEvent };

export class SseStreamReader {
  private inner = new SseFrameParser();
  private encoder = new TextEncoder();

  /**
   * `lastEventId` is carried between events per spec (`id:` persists until a
   * new id is received) and comes from the frame parser's stream state, so
   * data-less `id:` heartbeats and empty-id resets count too.
   */
  private dispatch(
    { event: e, lastEventId }: DispatchedSseEvent,
    onEvent: (e: ParsedSseEvent) => void
  ): void {
    const built: ParsedSseEvent = {
      event: e.event ?? 'message',
      data: e.data,
      ...(lastEventId !== undefined ? { lastEventId } : {}),
      ...(e.retry !== undefined ? { retry: e.retry } : {}),
    };
    onEvent(built);
  }

  /**
   * Feed raw text from the stream. Calls `onEvent` for each completed event.
   * Safe to call with any chunk size including partial lines.
   */
  feed(chunk: string, onEvent: (e: ParsedSseEvent) => void): void {
    const bytes = this.encoder.encode(chunk);
    for (const d of this.inner.feedWithState(bytes)) this.dispatch(d, onEvent);
  }

  /** Drop any buffered partial line and pending event. Call on connection close. */
  reset(): void {
    this.inner = new SseFrameParser();
  }

  /**
   * Read the current Last-Event-ID for use in reconnect headers. `""` means the
   * server reset it with an empty `id:` — send no `Last-Event-ID` header.
   */
  getLastEventId(): string | undefined {
    return this.inner.lastEventId;
  }

  /** Most recent valid server `retry:` (ms), or undefined if none was sent. */
  getReconnectionTime(): number | undefined {
    return this.inner.reconnectionTime;
  }
}

/**
 * Convenience: parse a complete event-stream string in one shot.
 * Useful in tests; production code should prefer the streaming `feed()` API.
 */
export function parseSseStream(text: string): ParsedSseEvent[] {
  const events: ParsedSseEvent[] = [];
  const reader = new SseStreamReader();
  reader.feed(text, (e) => events.push(e));
  // Spec says trailing data without a terminating blank line is not dispatched —
  // we follow that to match browser EventSource behavior.
  return events;
}
