/**
 * WebSocket connection ⇄ collection item (#1209).
 *
 * The item captures the connection settings, handshake headers, subprotocols,
 * the composer draft and the saved messages — stored unresolved. Live state
 * (status, message log, negotiated params, ping RTT) is never captured.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  useWebSocketStore,
  type WebSocketConnection,
} from '@/features/websocket/store/useWebSocketStore';
import {
  getWebSocketComposerDraft,
  setWebSocketComposerDraft,
} from '@/lib/shared/streaming/composerDrafts';
import { newTemplateId } from '@/lib/shared/streaming/messageTemplates';
import type { WebSocketPresetOptions, WebSocketRequest } from '@/types';

const copyRows = (rows: WebSocketConnection['headers']) => rows.map((r) => ({ ...r }));

/** Snapshot a live connection + its composer draft into a collection item. */
export function webSocketPresetFromConnection(
  conn: WebSocketConnection,
  name: string,
  id: string = uuidv4()
): WebSocketRequest {
  const draft = getWebSocketComposerDraft(conn.id);
  const options: WebSocketPresetOptions = {
    autoReconnect: conn.autoReconnect,
    maxReconnectAttempts: conn.maxReconnectAttempts,
    reconnectDelay: conn.reconnectDelay,
    heartbeatInterval: conn.heartbeatInterval,
    heartbeatMessage: conn.heartbeatMessage,
    ...(conn.perMessageDeflate !== undefined ? { perMessageDeflate: conn.perMessageDeflate } : {}),
  };
  return {
    id,
    name,
    type: 'websocket',
    url: conn.url,
    protocols: [...conn.protocols],
    headers: copyRows(conn.headers),
    message: draft ? { body: draft.body, format: draft.format } : { body: '', format: 'text' },
    templates: conn.templates.map((t) => ({ name: t.name, body: t.body, format: t.format })),
    options,
    ...(conn.frameAssertion
      ? {
          frameAssertion: {
            enabled: conn.frameAssertion.enabled,
            script: conn.frameAssertion.script,
          },
        }
      : {}),
  };
}

/** Seed connection `connectionId` (a fresh tab connection) from a saved item. */
export function applyWebSocketPreset(connectionId: string, preset: WebSocketRequest): void {
  const store = useWebSocketStore.getState();
  const o = preset.options ?? {};
  store.updateConnectionUrl(connectionId, preset.url);
  store.setHeaders(connectionId, copyRows(preset.headers));
  store.setProtocols(connectionId, [...preset.protocols]);
  store.setTemplates(
    connectionId,
    preset.templates.map((t) => ({ id: newTemplateId(), ...t }))
  );
  if (o.autoReconnect !== undefined) store.setAutoReconnect(connectionId, o.autoReconnect);
  if (o.heartbeatInterval !== undefined || o.heartbeatMessage !== undefined) {
    const conn = useWebSocketStore.getState().connections[connectionId];
    store.setHeartbeatConfig(
      connectionId,
      o.heartbeatInterval ?? conn?.heartbeatInterval ?? 0,
      o.heartbeatMessage ?? conn?.heartbeatMessage ?? 'ping'
    );
  }
  if (o.perMessageDeflate !== undefined) {
    store.patchControlState(connectionId, { perMessageDeflate: o.perMessageDeflate });
  }
  if (preset.frameAssertion) store.setFrameAssertion(connectionId, { ...preset.frameAssertion });
  if (o.maxReconnectAttempts !== undefined || o.reconnectDelay !== undefined) {
    useWebSocketStore.setState((state) => {
      const conn = state.connections[connectionId];
      if (!conn) return state;
      return {
        connections: {
          ...state.connections,
          [connectionId]: {
            ...conn,
            maxReconnectAttempts: o.maxReconnectAttempts ?? conn.maxReconnectAttempts,
            reconnectDelay: o.reconnectDelay ?? conn.reconnectDelay,
          },
        },
      };
    });
  }
  setWebSocketComposerDraft(connectionId, { ...preset.message });
}
