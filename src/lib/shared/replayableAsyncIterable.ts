/**
 * Turn a single-use async iterable (a response stream) into one that any
 * number of consumers can iterate, each from the start.
 *
 * The source is pumped once, eagerly, into a buffer; every iterator replays the
 * buffer and then waits for new items. This lets a viewer remount (React
 * StrictMode's double effect, switching tabs and back) without losing events or
 * the terminal item, and without one consumer's `break` ending the source for
 * the others.
 *
 * `maxRetained` bounds memory: once exceeded, the oldest items are dropped from
 * the replay buffer (a late consumer then starts mid-stream), but `isTerminal`
 * items are always kept so every consumer sees how the stream ended.
 */
export function replayableAsyncIterable<T>(
  source: AsyncIterable<T>,
  options: { maxRetained?: number; isTerminal?: (item: T) => boolean } = {}
): AsyncIterable<T> {
  const maxRetained = options.maxRetained ?? 5000;
  const isTerminal = options.isTerminal ?? (() => false);
  const buffer: T[] = [];
  /** Absolute index of buffer[0] (grows as old items are dropped). */
  let offset = 0;
  let done = false;
  let failure: { error: unknown } | undefined;
  let wake: (() => void) | undefined;
  let changed = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const notify = () => {
    const resolve = wake;
    changed = new Promise<void>((r) => {
      wake = r;
    });
    resolve?.();
  };

  void (async () => {
    try {
      for await (const item of source) {
        buffer.push(item);
        // Terminal items arrive last, so the oldest item is never one.
        if (buffer.length > maxRetained && !isTerminal(buffer[0] as T)) {
          buffer.shift();
          offset++;
        }
        notify();
      }
    } catch (error) {
      failure = { error };
    } finally {
      done = true;
      notify();
    }
  })();

  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      let next = 0;
      return {
        async next(): Promise<IteratorResult<T>> {
          for (;;) {
            if (next < offset) next = offset;
            const index = next - offset;
            if (index < buffer.length) {
              next++;
              return { value: buffer[index] as T, done: false };
            }
            if (done) {
              if (failure) throw failure.error;
              return { value: undefined, done: true };
            }
            await changed;
          }
        },
        async return(): Promise<IteratorResult<T>> {
          next = Number.POSITIVE_INFINITY;
          return { value: undefined, done: true };
        },
      };
    },
  };
}
