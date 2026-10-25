import { ConsumerFlowControl } from './consumer-flow';

/** Upper bound on decoding + sending one record before it is skipped. */
export const DEFAULT_DECODE_TIMEOUT_MS = 30_000;
/** How long a graceful unsubscribe lets queued records finish before aborting the rest. */
export const UNSUBSCRIBE_DRAIN_MS = 5_000;

export interface QueuedRecord {
  topic: string;
  partition: number;
  offset: bigint;
}

/**
 * Decode and send one record. Must not send once `signal` is aborted; resolving
 * `false` means the record was not sent (so it must not count as delivered).
 */
export type DeliverRecord<M> = (msg: M, signal: AbortSignal) => Promise<boolean | void>;

/**
 * The ordered decode/emit queue of one consumer stream, shared by group
 * sessions and browse mode:
 *  - records are decoded and sent strictly in arrival order;
 *  - the queue depth drives backpressure (`flow`, high-water 500, see consumer-flow.ts);
 *  - a decode that hangs past the timeout is aborted and skipped, never wedging the queue;
 *  - `close()` stops accepting records, optionally lets queued ones finish within
 *    a bound, then aborts the rest so nothing more is decoded or sent.
 */
export class OrderedDelivery<M extends QueuedRecord> {
  readonly flow = new ConsumerFlowControl();
  readonly #abort = new AbortController();
  #chain: Promise<void> = Promise.resolve();
  #closing: Promise<void> | undefined;

  constructor(
    private readonly deliver: DeliverRecord<M>,
    private readonly onError: (err: Error) => void,
    private readonly decodeTimeoutMs = DEFAULT_DECODE_TIMEOUT_MS
  ) {}

  /** Settles once every record queued so far has been forwarded, skipped or aborted. */
  get idle(): Promise<void> {
    return this.#chain;
  }

  get closed(): boolean {
    return this.#closing !== undefined;
  }

  /** Queue one record; `onDelivered` runs only if it was actually sent. Dropped once closing. */
  enqueue(msg: M, onDelivered?: () => void): void {
    if (this.#closing) return;
    this.flow.emitQueued();
    this.#chain = this.#chain
      .then(() => this.#run(msg, onDelivered))
      .catch(() => {})
      .finally(() => this.flow.emitSettled());
  }

  /**
   * Stop accepting records and resolve once the queue is settled. Queued records
   * get up to `drainMs` to finish (0 = abort at once); the rest are aborted.
   * A second call with `drainMs` 0 escalates a pending drain to an abort.
   */
  close(drainMs = 0): Promise<void> {
    if (drainMs <= 0) this.#abort.abort();
    if (this.#closing) return this.#closing;
    this.flow.detach();
    const tail = this.#chain;
    this.#closing = (async () => {
      if (!this.#abort.signal.aborted) await settleWithin(tail, drainMs, this.#abort.signal);
      this.#abort.abort();
      await tail;
    })();
    return this.#closing;
  }

  async #run(msg: M, onDelivered: (() => void) | undefined): Promise<void> {
    const outer = this.#abort.signal;
    if (outer.aborted) return;
    const record = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<'timeout' | 'aborted'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout');
        record.abort();
      }, this.decodeTimeoutMs);
      onAbort = () => {
        resolve('aborted');
        record.abort();
      };
      outer.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const outcome = await Promise.race([
        this.deliver(msg, record.signal).then((sent) => (sent === false ? 'dropped' : 'sent')),
        stopped,
      ]);
      if (outcome === 'sent') onDelivered?.();
      else if (outcome === 'timeout') {
        this.onError(
          new Error(
            `Decoding ${msg.topic}[${msg.partition}]@${msg.offset} timed out; the record was skipped.`
          )
        );
      }
    } finally {
      clearTimeout(timer);
      if (onAbort) outer.removeEventListener('abort', onAbort);
    }
  }
}

/** Wait for `promise` for at most `ms`, or until `signal` aborts. Never rejects. */
function settleWithin(promise: Promise<void>, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    promise.then(done, done);
  });
}
