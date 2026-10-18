/**
 * Consumer flow control for one Kafka subscription (#938).
 *
 * The whole-stream pause state has two independent reasons:
 *  - `userPaused`         — the renderer pressed "Pause consumer";
 *  - `backpressurePaused` — the ordered decode/emit queue in main exceeded its
 *                           high-water mark and has not yet drained to its low-water mark.
 * The native stream is paused while *any* reason holds and resumed only once
 * none does, so a backpressure drain can never undo a user pause (and a user
 * resume can never defeat backpressure).
 *
 * Partition-level pause is a separate concern (see `partition-pause.ts`).
 */

/** Above this many queued emits the stream is paused for backpressure. */
export const EMIT_QUEUE_HIGH_WATER = 500;
/** Backpressure is released once the queue drains to this many emits. */
export const EMIT_QUEUE_LOW_WATER = EMIT_QUEUE_HIGH_WATER / 2;

export interface PausableStream {
  pause(): unknown;
  resume(): unknown;
}

export class ConsumerFlowControl {
  #stream: PausableStream | undefined;
  #streamPaused = false;
  #userPaused = false;
  #backpressurePaused = false;
  #pending = 0;

  constructor(
    private readonly highWater = EMIT_QUEUE_HIGH_WATER,
    private readonly lowWater = highWater === EMIT_QUEUE_HIGH_WATER
      ? EMIT_QUEUE_LOW_WATER
      : Math.floor(highWater / 2)
  ) {}

  get userPaused(): boolean {
    return this.#userPaused;
  }

  get backpressurePaused(): boolean {
    return this.#backpressurePaused;
  }

  get pendingEmits(): number {
    return this.#pending;
  }

  /** Whether the native stream is currently held paused by this controller. */
  get streamPaused(): boolean {
    return this.#streamPaused;
  }

  /**
   * Bind a (new) native stream and force it into the current pause state.
   * Call after its `data` listener is attached: resuming a stream with no
   * listener would drop records on the floor.
   */
  attach(stream: PausableStream): void {
    this.#stream = stream;
    this.#streamPaused = this.#wantPaused();
    if (this.#streamPaused) stream.pause();
    else stream.resume();
  }

  /**
   * Stop driving the bound stream (used while it is being swapped out). Pause
   * reasons keep accumulating and are applied to the next `attach`.
   */
  detach(): void {
    this.#stream = undefined;
  }

  setUserPaused(paused: boolean): void {
    this.#userPaused = paused;
    this.#apply();
  }

  /** A record entered the ordered decode/emit queue. */
  emitQueued(): void {
    this.#pending += 1;
    if (!this.#backpressurePaused && this.#pending > this.highWater) {
      this.#backpressurePaused = true;
      this.#apply();
    }
  }

  /** A queued record finished (delivered, dropped, or failed to decode). */
  emitSettled(): void {
    this.#pending = Math.max(0, this.#pending - 1);
    if (this.#backpressurePaused && this.#pending <= this.lowWater) {
      this.#backpressurePaused = false;
      this.#apply();
    }
  }

  #wantPaused(): boolean {
    return this.#userPaused || this.#backpressurePaused;
  }

  #apply(): void {
    const want = this.#wantPaused();
    if (!this.#stream || want === this.#streamPaused) return;
    this.#streamPaused = want;
    if (want) this.#stream.pause();
    else this.#stream.resume();
  }
}
