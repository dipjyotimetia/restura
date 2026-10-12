import type { RequestTab, TabModeOverride } from '@/types';

/**
 * Connection-based modes that have no collection request type yet (#886):
 * their tab request is only an HTTP placeholder, so saving it would store a
 * misleading empty HTTP request. `null` = collectable (GraphQL saves as HTTP).
 * Typed as a full Record so a new mode must make an explicit choice.
 */
const UNCOLLECTABLE_LABEL: Record<TabModeOverride, string | null> = {
  graphql: null,
  websocket: 'WebSocket',
  socketio: 'Socket.IO',
  kafka: 'Kafka',
  mqtt: 'MQTT',
};

/**
 * Why `tab` can't be saved to a collection, or null when it can. Callers
 * disable Save to Collection and surface the reason (tooltip / toast).
 */
export function saveToCollectionBlockedReason(
  tab: Pick<RequestTab, 'modeOverride'>
): string | null {
  const label = tab.modeOverride ? UNCOLLECTABLE_LABEL[tab.modeOverride] : null;
  if (!label) return null;
  return `${label} sessions can't be saved to a collection yet. Collections hold HTTP, GraphQL, gRPC, SSE and MCP requests.`;
}
