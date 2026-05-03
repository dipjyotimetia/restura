// SSE wire-format parser. Mirror of src/features/sse/lib/sseParser.ts.
// Duplicated intentionally — the renderer and Electron main are independently
// buildable layers in this repo (no shared modules across the boundary).

export interface ParsedSseEvent {
  event: string;
  data: string;
  lastEventId?: string;
  retry?: number;
}

export class SseParser {
  private buffer = '';
  private currentLastEventId: string | undefined;
  private pendingEventName: string | undefined;
  private pendingDataLines: string[] = [];
  private pendingRetry: number | undefined;

  private flushEvent(onEvent: (e: ParsedSseEvent) => void): void {
    if (this.pendingDataLines.length === 0) {
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

  feed(chunk: string, onEvent: (e: ParsedSseEvent) => void): void {
    // Normalize the new chunk only — leftover in `this.buffer` was already normalized.
    this.buffer += chunk.replace(/\r\n?/g, '\n');

    let eolIndex: number;
    while ((eolIndex = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, eolIndex);
      this.buffer = this.buffer.slice(eolIndex + 1);

      if (line === '') {
        this.flushEvent(onEvent);
        continue;
      }
      if (line.startsWith(':')) continue;

      const colonIdx = line.indexOf(':');
      const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
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
          if (!value.includes('\0')) this.currentLastEventId = value;
          break;
        case 'retry': {
          const n = Number(value);
          if (Number.isInteger(n) && n >= 0) this.pendingRetry = n;
          break;
        }
        default:
          break;
      }
    }
  }

  reset(): void {
    this.buffer = '';
    this.currentLastEventId = undefined;
    this.pendingEventName = undefined;
    this.pendingDataLines = [];
    this.pendingRetry = undefined;
  }

  getLastEventId(): string | undefined {
    return this.currentLastEventId;
  }
}
