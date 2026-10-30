/**
 * Socket.IO connection ⇄ collection item (#1209).
 *
 * The item captures the connection settings (URL, namespace, path,
 * transports, reconnect knobs), handshake auth / query / headers, subscribed
 * events, the composer draft and the saved emits — stored unresolved. Live
 * state (status, event log) is never captured.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  SOCKETIO_CONNECTION_OPTION_DEFAULTS,
  type SocketIOConnection,
  useSocketIOStore,
} from '@/features/socketio/store/useSocketIOStore';
import {
  getSocketIoComposerDraft,
  setSocketIoComposerDraft,
} from '@/lib/shared/streaming/composerDrafts';
import { newTemplateId } from '@/lib/shared/streaming/messageTemplates';
import type { KeyValue, SocketIoRequest } from '@/types';

const copyRows = (rows: KeyValue[]) => rows.map((r) => ({ ...r }));

/** Snapshot a live connection + its composer draft into a collection item. */
export function socketIoPresetFromConnection(
  conn: SocketIOConnection,
  name: string,
  id: string = uuidv4()
): SocketIoRequest {
  const draft = getSocketIoComposerDraft(conn.id);
  return {
    id,
    name,
    type: 'socketio',
    url: conn.url,
    namespace: conn.namespace,
    path: conn.path,
    handshakeAuth: copyRows(conn.auth),
    ...(conn.authMode === 'json' ? { handshakeAuthMode: 'json' as const } : {}),
    ...(conn.authJson && conn.authJson.trim() !== '{}' ? { handshakeAuthJson: conn.authJson } : {}),
    query: copyRows(conn.query),
    headers: copyRows(conn.extraHeaders),
    transports: [...conn.transports],
    subscribedEvents: [...conn.subscribedEvents],
    emit: draft
      ? { eventName: draft.eventName, args: draft.args, ack: draft.ack }
      : { eventName: 'message', args: '', ack: false },
    templates: conn.templates.map((t) => ({
      name: t.name,
      eventName: t.eventName,
      args: t.args,
      ack: t.ack,
    })),
    options: {
      autoReconnect: conn.autoReconnect,
      reconnectionAttempts: conn.reconnectionAttempts,
      reconnectionDelay: conn.reconnectionDelay,
      reconnectionDelayMax: conn.reconnectionDelayMax,
      randomizationFactor: conn.randomizationFactor,
      timeout: conn.timeout,
      forceNew: conn.forceNew,
      volatile: conn.emitOptions.volatile,
      compress: conn.emitOptions.compress,
      ackTimeoutMs: conn.emitOptions.ackTimeoutMs,
    },
  };
}

/** Seed connection `connectionId` (a fresh tab connection) from a saved item. */
export function applySocketIoPreset(connectionId: string, preset: SocketIoRequest): void {
  const store = useSocketIOStore.getState();
  const set = store.updateConnectionField;
  const o = preset.options ?? {};
  set(connectionId, 'url', preset.url);
  set(connectionId, 'namespace', preset.namespace || '/');
  set(connectionId, 'path', preset.path || '/socket.io');
  set(connectionId, 'auth', copyRows(preset.handshakeAuth));
  set(connectionId, 'authMode', preset.handshakeAuthMode === 'json' ? 'json' : 'kv');
  if (preset.handshakeAuthJson !== undefined)
    set(connectionId, 'authJson', preset.handshakeAuthJson);
  set(connectionId, 'query', copyRows(preset.query));
  set(connectionId, 'extraHeaders', copyRows(preset.headers));
  if (preset.transports.length > 0) set(connectionId, 'transports', [...preset.transports]);
  set(connectionId, 'subscribedEvents', [...preset.subscribedEvents]);
  set(
    connectionId,
    'templates',
    preset.templates.map((t) => ({ id: newTemplateId(), ...t }))
  );
  if (o.autoReconnect !== undefined) set(connectionId, 'autoReconnect', o.autoReconnect);
  if (o.reconnectionAttempts !== undefined) {
    set(connectionId, 'reconnectionAttempts', o.reconnectionAttempts);
  }
  if (o.reconnectionDelay !== undefined) {
    set(connectionId, 'reconnectionDelay', o.reconnectionDelay);
  }
  if (o.timeout !== undefined) set(connectionId, 'timeout', o.timeout);
  if (o.forceNew !== undefined) set(connectionId, 'forceNew', o.forceNew);
  if (o.reconnectionDelayMax !== undefined) {
    set(connectionId, 'reconnectionDelayMax', o.reconnectionDelayMax);
  }
  if (o.randomizationFactor !== undefined) {
    set(connectionId, 'randomizationFactor', o.randomizationFactor);
  }
  if (o.volatile !== undefined || o.compress !== undefined || o.ackTimeoutMs !== undefined) {
    const current = useSocketIOStore.getState().connections[connectionId]?.emitOptions;
    set(connectionId, 'emitOptions', {
      ...(current ?? SOCKETIO_CONNECTION_OPTION_DEFAULTS.emitOptions),
      ...(o.volatile !== undefined ? { volatile: o.volatile } : {}),
      ...(o.compress !== undefined ? { compress: o.compress } : {}),
      // 0 would time every ack out at once (the desktop IPC schema rejects it).
      ...(o.ackTimeoutMs ? { ackTimeoutMs: Math.min(o.ackTimeoutMs, 60_000) } : {}),
    });
  }
  setSocketIoComposerDraft(connectionId, { ...preset.emit });
}
