// Compatibility shim around the canonical SSE parser at
// @shared/protocol/sse-parser. Preserves the existing string/callback public
// API used by sse-handler and mcp-handler (event defaults to 'message',
// lastEventId persists across events per spec, reset()/getLastEventId()).
//
// TODO(plan: 2026-05-09-streaming-and-h2): once consumers migrate to the
// shared parser's feed(Uint8Array): SseEvent[] API directly, delete this shim.

import { SseParser as SharedSseParser, type SseEvent } from '@shared/protocol/sse-parser';

export interface ParsedSseEvent {
  event: string;
  data: string;
  lastEventId?: string;
  retry?: number;
}

export class SseParser {
  private inner = new SharedSseParser();
  private encoder = new TextEncoder();
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

  feed(chunk: string, onEvent: (e: ParsedSseEvent) => void): void {
    const bytes = this.encoder.encode(chunk);
    for (const e of this.inner.feed(bytes)) this.dispatch(e, onEvent);
  }

  reset(): void {
    this.inner = new SharedSseParser();
    this.currentLastEventId = undefined;
  }

  getLastEventId(): string | undefined {
    return this.currentLastEventId;
  }
}
