import type { WebContents } from 'electron';

// Per-handler dedupe of webContents ids that already have a `destroyed`
// listener — without it, every reconnect from the same renderer stacks a
// new listener (Node warns at 10, but the real cost is N teardowns per close).
const boundByHandler = new WeakMap<object, Set<number>>();

/**
 * Idempotently registers a one-shot `destroyed` listener on `webContents`
 * that invokes `teardown(webContentsId)`. `handlerKey` dedupes across
 * reconnects (the handler's `activeConnections` Map works fine as the key).
 */
export function bindRendererCleanup(
  handlerKey: object,
  webContents: WebContents,
  teardown: (webContentsId: number) => void
): void {
  if (webContents.isDestroyed()) {
    teardown(webContents.id);
    return;
  }
  let bound = boundByHandler.get(handlerKey);
  if (!bound) {
    bound = new Set<number>();
    boundByHandler.set(handlerKey, bound);
  }
  const id = webContents.id;
  if (bound.has(id)) return;
  bound.add(id);
  webContents.once('destroyed', () => {
    bound.delete(id);
    try {
      teardown(id);
    } catch (err) {
      console.error('[connection-cleanup] teardown failed:', err);
    }
  });
}

/**
 * Walk a connection map, run `dispose` on every entry owned by `deadId`,
 * and delete it. Centralises the "match webContentsId → cleanup → delete"
 * loop that every long-lived-transport handler needs.
 */
export function disposeByOwner<V extends { webContentsId: number }>(
  map: Map<string, V>,
  deadId: number,
  dispose: (entry: V) => void
): void {
  for (const [id, entry] of map) {
    if (entry.webContentsId !== deadId) continue;
    try { dispose(entry); } catch { /* swallow — best-effort cleanup */ }
    map.delete(id);
  }
}
