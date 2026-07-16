interface ConnectionLifecycle {
  connectionIdForTab: (tabId: string) => string | undefined;
  disconnect: (connectionId: string) => void | Promise<void>;
  removeConnectionForTab: (tabId: string) => void;
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
