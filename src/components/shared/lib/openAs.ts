import { useSocketIOStore } from '@/features/socketio/store/useSocketIOStore';
import { useWebSocketStore } from '@/features/websocket/store/useWebSocketStore';
import { useRequestStore } from '@/store/useRequestStore';
import type { RequestMode, RequestTab } from '@/types';

/** The workspace mode a tab shows (connection modes override the request type). */
export function tabMode(tab: RequestTab): RequestMode {
  return tab.modeOverride ?? tab.request.type;
}

/**
 * Modes whose URL lives with the tab itself, so "Open as" can seed it. SSE and
 * MCP keep their request config on the tab (`tab.request.url`). Kafka and MQTT
 * have no single URL (broker lists) — nothing to seed.
 */
const SEEDABLE: ReadonlySet<RequestMode> = new Set([
  'http',
  'graphql',
  'grpc',
  'websocket',
  'socketio',
  'sse',
  'mcp',
]);

export function carriesUrl(mode: RequestMode): boolean {
  return SEEDABLE.has(mode);
}

/** The URL a tab is pointed at, wherever its protocol keeps it. */
export function sourceUrlOf(tab: RequestTab): string {
  switch (tabMode(tab)) {
    case 'websocket': {
      const s = useWebSocketStore.getState();
      const id = s.connectionByTabId[tab.id];
      return (id && s.connections[id]?.url) || '';
    }
    case 'socketio': {
      const s = useSocketIOStore.getState();
      const id = s.connectionByTabId[tab.id];
      return (id && s.connections[id]?.url) || '';
    }
    case 'kafka':
    case 'mqtt':
      return '';
    default:
      return tab.request.url;
  }
}

/** Swap http(s) ↔ ws(s) so the URL suits the target protocol. */
export function convertUrlForMode(url: string, mode: RequestMode): string {
  if (mode === 'websocket') return url.replace(/^http(s?):\/\//i, 'ws$1://');
  return url.replace(/^ws(s?):\/\//i, 'http$1://');
}

/** Seed `url` into the freshly opened (active) tab of `mode`. */
export function seedUrl(tabId: string, mode: RequestMode, url: string): void {
  if (!url || !carriesUrl(mode)) return;
  const next = convertUrlForMode(url, mode);
  if (mode === 'websocket') {
    useWebSocketStore.getState().ensureConnectionForTab(tabId, next);
  } else if (mode === 'socketio') {
    useSocketIOStore.getState().ensureConnectionForTab(tabId, next);
  } else {
    useRequestStore.getState().updateRequest({ url: next });
  }
}
