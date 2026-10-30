/**
 * Collection-side glue for saved WebSocket / Socket.IO connections (#1209):
 * opening a saved item into a connection-mode tab and snapshotting a
 * WebSocket / Socket.IO tab into an item (new item or save-back).
 *
 * Both protocols run on web and desktop. Unlike Kafka / MQTT presets there is
 * no secure-storage scope: the connection stores keep handshake headers /
 * query / auth rows as plain key/value rows, so the item does too (export
 * redaction blanks the credential-looking ones).
 */

import {
  applySocketIoPreset,
  socketIoPresetFromConnection,
} from '@/features/socketio/lib/socketioPreset';
import { useSocketIOStore } from '@/features/socketio/store/useSocketIOStore';
import {
  applyWebSocketPreset,
  webSocketPresetFromConnection,
} from '@/features/websocket/lib/websocketPreset';
import { useWebSocketStore } from '@/features/websocket/store/useWebSocketStore';
import { useRequestStore } from '@/store/useRequestStore';
import type { RequestTab, StreamPresetRequest } from '@/types';

/**
 * Open a saved WebSocket / Socket.IO item in a new connection tab linked to
 * `itemId`, seeded with its settings, saved messages and composer draft.
 * Returns the tab id.
 */
export function openStreamPreset(itemId: string, preset: StreamPresetRequest): string {
  const requests = useRequestStore.getState();
  const tabId = requests.openTabWithMode(preset.type);
  requests.renameTab(tabId, preset.name);
  requests.linkTabToSavedRequest(tabId, itemId);
  if (preset.type === 'websocket') {
    const connectionId = useWebSocketStore.getState().ensureConnectionForTab(tabId, preset.url);
    applyWebSocketPreset(connectionId, preset);
  } else {
    const connectionId = useSocketIOStore.getState().ensureConnectionForTab(tabId, preset.url);
    applySocketIoPreset(connectionId, preset);
  }
  return tabId;
}

/**
 * Snapshot a WebSocket / Socket.IO tab into an item named `name` (reusing
 * `id` for a save-back), or null when the tab is not such a tab or its panel
 * never created a connection.
 */
export function snapshotStreamTab(
  tab: Pick<RequestTab, 'id' | 'modeOverride'>,
  name: string,
  id?: string
): StreamPresetRequest | null {
  if (tab.modeOverride === 'websocket') {
    const state = useWebSocketStore.getState();
    const conn = state.connections[state.connectionByTabId[tab.id] ?? ''];
    return conn ? webSocketPresetFromConnection(conn, name, id) : null;
  }
  if (tab.modeOverride === 'socketio') {
    const state = useSocketIOStore.getState();
    const conn = state.connections[state.connectionByTabId[tab.id] ?? ''];
    return conn ? socketIoPresetFromConnection(conn, name, id) : null;
  }
  return null;
}
