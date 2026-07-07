/**
 * Newest-first ordering for run records — the single definition shared by the
 * run stores' `listRuns()` and the components' reactive memos (which must
 * derive from their subscribed `runs` slice rather than call the accessor).
 */
export function newestFirst<T extends { startedAt: number }>(byId: Record<string, T>): T[] {
  return Object.values(byId).sort((a, b) => b.startedAt - a.startedAt);
}
