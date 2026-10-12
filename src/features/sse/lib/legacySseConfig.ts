import { useRequestStore } from '@/store/useRequestStore';
import type { KeyValue, RequestTab } from '@/types';

/**
 * One-time carry-over of SSE request config from the pre-#873 store shape.
 *
 * Before #873 the SSE builder kept its URL / headers on the connection-scoped
 * `useSseStore.connections[id]` (persisted as `sse-storage`), while the tab's
 * `SseRequest.url` stayed blank. The builder now reads `tab.request`, so an
 * upgraded user's SSE tab would open with an empty URL and their configured
 * endpoint would be silently dropped the next time the store persists
 * (partialize no longer writes those fields).
 *
 * On rehydrate we read the legacy blob once — the active connection, falling
 * back to the first — and copy its url (plus headers, when the tab has none)
 * into every SSE tab whose url is blank. Tabs with a url are never touched,
 * so re-running is a no-op.
 */
export interface LegacySseConfig {
  url: string;
  headers: KeyValue[];
}

interface LegacyConnectionShape {
  url?: unknown;
  headers?: unknown;
}

function isKeyValue(v: unknown): v is KeyValue {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.key === 'string' && typeof r.value === 'string';
}

/** Pull the legacy url/headers out of a rehydrated `useSseStore` state; null when absent. */
export function extractLegacySseConfig(state: unknown): LegacySseConfig | null {
  if (!state || typeof state !== 'object') return null;
  const { connections, activeConnectionId } = state as {
    connections?: Record<string, LegacyConnectionShape>;
    activeConnectionId?: unknown;
  };
  if (!connections || typeof connections !== 'object') return null;
  const conn =
    (typeof activeConnectionId === 'string' ? connections[activeConnectionId] : undefined) ??
    Object.values(connections)[0];
  if (!conn || typeof conn.url !== 'string' || !conn.url.trim()) return null;
  const headers = Array.isArray(conn.headers) ? conn.headers.filter(isKeyValue) : [];
  return { url: conn.url, headers: headers.map((h) => ({ ...h })) };
}

/** Pure: SSE tabs with a blank url inherit the legacy url (and headers when they have none). */
export function applyLegacySseConfig(tabs: RequestTab[], legacy: LegacySseConfig): RequestTab[] {
  let changed = false;
  const next = tabs.map((tab) => {
    const r = tab.request;
    if (r.type !== 'sse' || r.url.trim()) return tab;
    changed = true;
    return {
      ...tab,
      request: {
        ...r,
        url: legacy.url,
        headers: r.headers.length > 0 ? r.headers : legacy.headers.map((h) => ({ ...h })),
      },
    };
  });
  return changed ? next : tabs;
}

/** Drop the legacy request-config keys from the in-memory connections. */
function shedLegacyFields(state: unknown): void {
  const connections = (state as { connections?: Record<string, Record<string, unknown>> })
    ?.connections;
  for (const conn of Object.values(connections ?? {})) {
    for (const k of ['url', 'headers', 'auth', 'eventNameFilter', 'reconnectOnResume']) {
      delete conn[k];
    }
  }
}

/**
 * `useSseStore` onRehydrate hook. Waits for the request-tab store to finish
 * hydrating (both are async Dexie reads) before patching its tabs.
 */
export function migrateLegacySseConfig(state: unknown): void {
  const legacy = extractLegacySseConfig(state);
  shedLegacyFields(state);
  if (!legacy) return;
  const apply = () =>
    useRequestStore.setState((s) => {
      const tabs = applyLegacySseConfig(s.tabs, legacy);
      return tabs === s.tabs ? s : { tabs };
    });
  const persistApi = useRequestStore.persist;
  if (!persistApi || persistApi.hasHydrated()) {
    apply();
    return;
  }
  const unsubscribe = persistApi.onFinishHydration(() => {
    unsubscribe();
    apply();
  });
}
