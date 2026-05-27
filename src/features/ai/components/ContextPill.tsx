import { useRequestStore } from '@/store/useRequestStore';

/** Minimal view of the request store this pill reads. */
interface RequestStoreShape {
  activeTabId: string | null;
  tabs: Array<{
    id: string;
    modeOverride?: string;
    request?: { type?: string; method?: string; url?: string };
    response?: { status?: number } | null;
  }>;
}

/**
 * Derive the context label. The tab's protocol is `modeOverride` (WS / Socket.IO
 * / Kafka / GraphQL placeholder tabs) falling back to the request's `type`
 * (HTTP / gRPC / SSE / MCP) — `tab.mode` does not exist, so the old code always
 * showed "HTTP".
 */
function computeLabel(s: RequestStoreShape): string {
  if (!s.activeTabId) return 'No active tab';
  const tab = s.tabs.find((t) => t.id === s.activeTabId);
  if (!tab) return 'No active tab';
  const mode = tab.modeOverride ?? tab.request?.type ?? 'http';
  const method = tab.request?.method ?? '';
  const url = tab.request?.url ?? '';
  const status = tab.response?.status;
  const parts = [mode.toUpperCase(), `${method} ${url || '(no URL)'}`.trim()];
  if (status) parts.push(`${status}`);
  return parts.filter(Boolean).join(' · ');
}

/**
 * Shows the AI's current context target: the active tab's protocol mode,
 * method + URL, and the last response status (read from the active tab).
 *
 * Subscribes via a selector that returns the derived label string, so the pill
 * re-renders only when that string changes — not on every request-store
 * mutation (the store churns on every keystroke in the URL/body/header editors).
 */
export function ContextPill() {
  const label = useRequestStore((s) => computeLabel(s as unknown as RequestStoreShape));

  return (
    <div className="glass-1 border-border/40 mx-3 mt-2 truncate rounded-md border px-2 py-1 text-[11px] text-muted-foreground">
      <span aria-hidden>· </span>
      {label}
    </div>
  );
}
