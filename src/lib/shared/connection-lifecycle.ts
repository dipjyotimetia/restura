export interface ConnectionLifecycle {
  connectionIdForTab: (tabId: string) => string | undefined;
  disconnect: (connectionId: string) => void | Promise<void>;
  removeConnectionForTab: (tabId: string) => void;
  /** True while the tab's connection is open or (re)connecting — used to confirm before closing the tab. */
  isLive?: (tabId: string) => boolean;
}

/** Status values that mean a connection is open or actively (re)connecting. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(['connecting', 'connected', 'reconnecting']);

/** Shared `isLive` predicate for status-string connection stores. */
export function isLiveStatus(status: string | undefined): boolean {
  return status !== undefined && LIVE_STATUSES.has(status);
}

/**
 * Coordinates runtime teardown with pure store cleanup without making a store
 * depend on its manager. Disconnect is best-effort because close events may
 * race with tab removal or application shutdown.
 */
export function cleanupConnectionLifecycle(tabId: string, lifecycle: ConnectionLifecycle): void {
  const connectionId = lifecycle.connectionIdForTab(tabId);
  if (!connectionId) return;

  try {
    void Promise.resolve(lifecycle.disconnect(connectionId)).catch(() => undefined);
  } catch {
    // Synchronous disconnect failures are also best-effort.
  } finally {
    lifecycle.removeConnectionForTab(tabId);
  }
}
