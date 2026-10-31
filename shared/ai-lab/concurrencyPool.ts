// Shared bounded-concurrency worker pool. One implementation for the eval
// runner, the baseline precompute, and the Arena — they all sweep a fixed task
// list at a concurrency cap with cooperative cancellation. `work` receives the
// item's stable index so order-sensitive callers (Arena → Elo) can place
// results deterministically instead of in completion order.
export async function runPool<T>(
  items: T[],
  concurrency: number,
  signal: AbortSignal,
  work: (item: T, index: number) => Promise<void>
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal.aborted) return;
      const idx = next++;
      if (idx >= items.length) return;
      const item = items[idx];
      if (item === undefined) continue; // defensive: skip holes
      await work(item, idx);
    }
  };
  const pool = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: pool }, () => worker()));
}
