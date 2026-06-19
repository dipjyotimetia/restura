/**
 * Compatibility shim around the canonical SSE parser at
 * `@shared/protocol/sse-parser`. The renderer's existing public API —
 * string-based feed with a callback, `event` defaulting to 'message',
 * `lastEventId` carried across events per the W3C spec, and `parseSseStream`
 * one-shot helper — is preserved so callsites in `sseManager` and tests do not
 * need to change.
 *
 * TODO(plan: 2026-05-09-streaming-and-h2): once consumers migrate to the
 * shared parser's `feed(Uint8Array): SseEvent[]` API directly, delete this
 * shim.
 */

import {
  SseParser as SharedSseParser,
  type SseEvent,
  type ParsedSseEvent,
} from '@shared/protocol/sse-parser';

export type { ParsedSseEvent };

export class SseParser {
  private inner = new SharedSseParser();
  private encoder = new TextEncoder();
  /** Carry between events per spec — `id:` persists until a new id is received. */
  private currentLastEventId: string | undefined;

  private dispatch(e: SseEvent, onEvent: (e: ParsedSseEvent) => void): void {
    if (e.id !== undefined) this.currentLastEventId = e.id;
    const built: ParsedSseEvent = {
      event: e.event ?? 'message',
      data: e.data,
      ...(this.currentLastEventId !== undefined ? { lastEventId: this.currentLastEventId } : {}),
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
    for (const e of this.inner.feed(bytes)) this.dispatch(e, onEvent);
  }

  /** Drop any buffered partial line and pending event. Call on connection close. */
  reset(): void {
    this.inner = new SharedSseParser();
    this.currentLastEventId = undefined;
  }

  /** Read the current Last-Event-ID for use in reconnect headers. */
  getLastEventId(): string | undefined {
    return this.currentLastEventId;
  }
}

/**
 * Convenience: parse a complete event-stream string in one shot.
 * Useful in tests; production code should prefer the streaming `feed()` API.
 */
export function parseSseStream(text: string): ParsedSseEvent[] {
  const events: ParsedSseEvent[] = [];
  const parser = new SseParser();
  parser.feed(text, (e) => events.push(e));
  // Spec says trailing data without a terminating blank line is not dispatched —
  // we follow that to match browser EventSource behavior.
  return events;
}
