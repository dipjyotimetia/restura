/** The slice of a Kafka connection entry that holds its (single) consumer. */
export interface ConsumerTeardownEntry {
  consumer?: { close(force: boolean): unknown } | undefined;
  stream?: { close(): unknown } | undefined;
  session?: { close(drainMs?: number): Promise<void> } | undefined;
  browse?: { close(): Promise<void> | void } | undefined;
  pendingCommits: { clear(): void };
}

const inFlight = new WeakMap<ConsumerTeardownEntry, Promise<void>>();

/**
 * Close the entry's consumer, stream and delivery queue, freeing its consumer
 * slot. Queued records get `drainMs` to reach the renderer before the rest are
 * aborted, then the session commits what was actually sent. Browse has nothing
 * to commit, so its queue is always aborted at once.
 *
 * Single-flight per entry: the stream's own 'close' event (fired during this
 * teardown, or on its own when the stream dies) re-enters through the session
 * hooks and must share the running teardown rather than race a second one.
 */
export function closeConsumerAndStream(entry: ConsumerTeardownEntry, drainMs = 0): Promise<void> {
  const running = inFlight.get(entry);
  if (running) return running;
  const teardown = releaseConsumer(entry, drainMs).finally(() => inFlight.delete(entry));
  inFlight.set(entry, teardown);
  return teardown;
}

async function releaseConsumer(entry: ConsumerTeardownEntry, drainMs: number): Promise<void> {
  await (entry.session?.close(drainMs) ?? entry.browse?.close());
  if (entry.stream) {
    try {
      await Promise.resolve(entry.stream.close());
    } catch {
      /* ignore */
    }
    entry.stream = undefined;
    entry.session = undefined;
    entry.browse = undefined;
  }
  if (entry.consumer) {
    try {
      await Promise.resolve(entry.consumer.close(true));
    } catch {
      /* ignore */
    }
    entry.consumer = undefined;
  }
  entry.pendingCommits.clear();
}
