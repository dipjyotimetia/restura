import { useHistoryStore } from '@/store/useHistoryStore';
import type { SseRequest } from '@/types';
import { useSseStore } from '../store/useSseStore';

/**
 * One History entry per user-started SSE stream, written when that stream
 * first reaches `connected` (not on auto-reconnects). Pending entries are
 * keyed by connection and flushed from a store subscription, so a stream that
 * connects while its tab is in the background (or while no SSE tab is mounted)
 * is still recorded. `addHistoryItem` redacts inline credentials and URL
 * secrets the same way it does for HTTP.
 */
const pending = new Map<string, { request: SseRequest; url: string }>();
let unsubscribe: (() => void) | null = null;

function flush(): void {
  if (pending.size === 0) return;
  const { connections } = useSseStore.getState();
  for (const [connectionId, entry] of pending) {
    const status = connections[connectionId]?.status;
    if (status === undefined) {
      pending.delete(connectionId); // connection removed (tab closed)
    } else if (status === 'connected') {
      pending.delete(connectionId);
      useHistoryStore.getState().addHistoryItem(entry.request, undefined, entry.url);
    }
  }
}

/** Record a history entry for this connection once it connects. */
export function queueSseHistory(connectionId: string, request: SseRequest, url: string): void {
  pending.set(connectionId, { request, url });
  unsubscribe ??= useSseStore.subscribe(flush);
  flush();
}

/** Drop a pending entry (the user stopped the stream before it connected). */
export function cancelSseHistory(connectionId: string): void {
  pending.delete(connectionId);
}

/** Test seam. */
export function resetSseHistoryForTests(): void {
  pending.clear();
  unsubscribe?.();
  unsubscribe = null;
}
