import { isElectron } from '@/lib/shared/platform';
import type { RequestTab, TabModeOverride } from '@/types';

/**
 * Connection-based modes that have no collection request type yet (#886):
 * their tab request is only an HTTP placeholder, so saving it would store a
 * misleading empty HTTP request. `null` = collectable (GraphQL saves as HTTP;
 * Kafka / MQTT save as connection presets, #984; WebSocket / Socket.IO save
 * as connection items, #1209). Typed as a full Record so a new mode must make
 * an explicit choice.
 */
const UNCOLLECTABLE_LABEL: Record<TabModeOverride, string | null> = {
  graphql: null,
  websocket: null,
  socketio: null,
  kafka: null,
  mqtt: null,
};

/**
 * Broker presets snapshot the live desktop connection, which only exists in
 * the Electron build — the web build renders a "Desktop only" panel instead.
 */
const DESKTOP_ONLY_LABEL: Partial<Record<TabModeOverride, string>> = {
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
  const mode = tab.modeOverride;
  if (!mode) return null;
  const desktopOnly = DESKTOP_ONLY_LABEL[mode];
  if (desktopOnly && !isElectron()) {
    return `${desktopOnly} presets can only be saved from the Restura desktop app.`;
  }
  const label = UNCOLLECTABLE_LABEL[mode];
  if (!label) return null;
  return `${label} sessions can't be saved to a collection yet. Collections hold HTTP, GraphQL, gRPC, SSE, MCP, WebSocket, Socket.IO, Kafka and MQTT items.`;
}
