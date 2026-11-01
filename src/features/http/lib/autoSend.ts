/**
 * One-shot "send this tab as soon as its HTTP builder mounts".
 *
 * Used by the first-run welcome screen's live demo: the demo must go through
 * the real send path (`useHttpRequestPage().sendRequest` → requestExecutor,
 * scripts, history) rather than a parallel HTTP call, but the builder is not
 * mounted while the welcome screen is showing. The caller queues the tab id;
 * the builder consumes it once, after it renders with that tab active.
 */
let pendingTabId: string | null = null;

export function queueAutoSend(tabId: string): void {
  pendingTabId = tabId;
}

/** True exactly once for the queued tab id; clears the queue on a match. */
export function consumeAutoSend(tabId: string | null | undefined): boolean {
  if (!tabId || pendingTabId !== tabId) return false;
  pendingTabId = null;
  return true;
}
