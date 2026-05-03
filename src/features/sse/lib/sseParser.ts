/**
 * SSE wire-format parser. Implements the spec at
 * https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream
 *
 * Use a single instance per connection: it carries buffered text across reads,
 * since chunks from a network stream don't honor SSE's line/event boundaries.
 *
 * Parsed events arrive via the callback in `feed()`. Comments (lines starting
 * with `:`) are silently dropped. Unknown fields are silently dropped per spec.
 */

export interface ParsedSseEvent {
  /** Server-supplied event name; defaults to "message" */
  event: string;
  /** Concatenated `data:` lines, joined with LF */
  data: string;
  /** Server-supplied `id:` value if present in this event */
  lastEventId?: string;
  /** Server-supplied `retry:` value (ms) if present in this event */
  retry?: number;
}

export class SseParser {
  private buffer = '';
  /** Carry between events per spec — `id:` persists until a new id is received. */
  private currentLastEventId: string | undefined;
  /** In-progress event being accumulated. Must persist across feed() calls
   *  because the network can split a single event into multiple chunks. */
  private pendingEventName: string | undefined;
  private pendingDataLines: string[] = [];
  private pendingRetry: number | undefined;

  private flushEvent(onEvent: (e: ParsedSseEvent) => void): void {
    if (this.pendingDataLines.length === 0) {
      // Reset the per-event state but don't dispatch
      this.pendingEventName = undefined;
      this.pendingRetry = undefined;
      return;
    }
    const built: ParsedSseEvent = {
      event: this.pendingEventName || 'message',
      data: this.pendingDataLines.join('\n'),
      ...(this.currentLastEventId !== undefined ? { lastEventId: this.currentLastEventId } : {}),
      ...(this.pendingRetry !== undefined ? { retry: this.pendingRetry } : {}),
    };
    onEvent(built);
    this.pendingEventName = undefined;
    this.pendingDataLines = [];
    this.pendingRetry = undefined;
  }

  /**
   * Feed raw text from the stream. Calls `onEvent` for each completed event.
   * Safe to call with any chunk size including partial lines.
   */
  feed(chunk: string, onEvent: (e: ParsedSseEvent) => void): void {
    // Normalize the new chunk only — leftover in `this.buffer` was already normalized
    // on its previous feed(), so re-scanning it would be O(buffer²) on long streams.
    this.buffer += chunk.replace(/\r\n?/g, '\n');

    let eolIndex: number;
    while ((eolIndex = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, eolIndex);
      this.buffer = this.buffer.slice(eolIndex + 1);

      if (line === '') {
        // Empty line = event boundary — dispatch
        this.flushEvent(onEvent);
        continue;
      }

      if (line.startsWith(':')) {
        // Comment line — ignored
        continue;
      }

      // Field is everything before the first colon. Value is everything after.
      // If there's no colon, the whole line is the field name with empty value.
      const colonIdx = line.indexOf(':');
      const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
      // Per spec, a single leading space in the value is removed.
      let value = colonIdx === -1 ? '' : line.slice(colonIdx + 1);
      if (value.startsWith(' ')) value = value.slice(1);

      switch (field) {
        case 'event':
          this.pendingEventName = value;
          break;
        case 'data':
          this.pendingDataLines.push(value);
          break;
        case 'id':
          // Per spec, ignore id values that contain a NULL character.
          if (!value.includes('\0')) this.currentLastEventId = value;
          break;
        case 'retry': {
          const n = Number(value);
          if (Number.isInteger(n) && n >= 0) this.pendingRetry = n;
          break;
        }
        default:
          // Unknown field — ignore per spec
          break;
      }
    }
  }

  /** Drop any buffered partial line and pending event. Call on connection close. */
  reset(): void {
    this.buffer = '';
    this.currentLastEventId = undefined;
    this.pendingEventName = undefined;
    this.pendingDataLines = [];
    this.pendingRetry = undefined;
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
