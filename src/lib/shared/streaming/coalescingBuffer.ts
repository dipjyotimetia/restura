/**
 * Per-connection inbound buffer. The first item after a flush arms a single
 * timer; everything arriving before it fires lands in one `sink` call, in
 * arrival order. A busy stream can deliver thousands of items per second;
 * coalescing keeps store updates and list re-renders at a fixed rate.
 *
 * `flush` drains synchronously so lifecycle messages (closed, errors,
 * unsubscribe) never overtake items that arrived before them, and so the
 * last interval isn't dropped when a connection's listeners are detached.
 */
export interface CoalescingBufferOptions {
  intervalMs: number;
  /** Keep only the newest N items between flushes (the consumer would drop the rest anyway). */
  maxBuffered?: number | undefined;
}

export class CoalescingBuffer<T> {
  private readonly buffers = new Map<string, T[]>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly intervalMs: number;
  private readonly maxBuffered: number | undefined;

  constructor(
    private readonly sink: (connectionId: string, batch: T[]) => void,
    { intervalMs, maxBuffered }: CoalescingBufferOptions
  ) {
    this.intervalMs = intervalMs;
    this.maxBuffered = maxBuffered;
  }

  push(connectionId: string, item: T): void {
    const buf = this.buffers.get(connectionId);
    if (buf) {
      buf.push(item);
      if (this.maxBuffered !== undefined && buf.length > this.maxBuffered) {
        buf.splice(0, buf.length - this.maxBuffered);
      }
    } else this.buffers.set(connectionId, [item]);
    if (!this.timers.has(connectionId)) {
      this.timers.set(
        connectionId,
        setTimeout(() => this.flush(connectionId), this.intervalMs)
      );
    }
  }

  /** Drop pending items without delivering them (the log was cleared). */
  discard(connectionId: string): void {
    this.cancelTimer(connectionId);
    this.buffers.delete(connectionId);
  }

  /** Deliver what is pending now, in one `sink` call. No-op when empty. */
  flush(connectionId: string): void {
    this.cancelTimer(connectionId);
    const buf = this.buffers.get(connectionId);
    if (!buf || buf.length === 0) return;
    this.buffers.delete(connectionId);
    this.sink(connectionId, buf);
  }

  private cancelTimer(connectionId: string): void {
    const timer = this.timers.get(connectionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(connectionId);
  }
}
