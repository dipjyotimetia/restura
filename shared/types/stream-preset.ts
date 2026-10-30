import type { KeyValue } from './common';

/**
 * WebSocket / Socket.IO connections saved as collection items (#1209).
 *
 * Like the Kafka / MQTT presets (`./broker.ts`) these are collection-only
 * kinds: opening one seeds a fresh connection-mode tab (`modeOverride`) with
 * the saved connection settings, composer draft and saved messages. Nothing
 * here is a live connection, and neither kind is a runnable request — the
 * collection runner and the CLI skip them with a reason.
 *
 * Unlike broker presets, the connection stores keep handshake headers, query
 * and Socket.IO auth rows as plain key/value rows, so these shapes do too.
 * Credential-looking rows are blanked by export redaction
 * (`shared/secrets/stream-preset-redaction.ts`) and the Socket.IO handshake
 * auth payload (`handshakeAuth`) is blanked wholesale. Every string may hold `{{var}}`
 * tokens; values are stored unresolved.
 */

export type WebSocketPresetFormat = 'text' | 'json' | 'hex';

export interface WebSocketPresetMessage {
  name: string;
  body: string;
  format: WebSocketPresetFormat;
}

export interface WebSocketPresetOptions {
  autoReconnect?: boolean;
  maxReconnectAttempts?: number;
  reconnectDelay?: number;
  /** ms, 0 = disabled. */
  heartbeatInterval?: number;
  heartbeatMessage?: string;
  /** Desktop only: false disables the permessage-deflate offer. */
  perMessageDeflate?: boolean;
}

export interface WebSocketRequest {
  id: string;
  name: string;
  type: 'websocket';
  description?: string;
  url: string;
  protocols: string[];
  /** Handshake headers. */
  headers: KeyValue[];
  /** Composer draft: the message the panel opens with. */
  message: Omit<WebSocketPresetMessage, 'name'>;
  /** Saved messages, stored unresolved. */
  templates: WebSocketPresetMessage[];
  options?: WebSocketPresetOptions;
  /** Per-frame assertion script (#931). */
  frameAssertion?: { enabled: boolean; script: string };
}

export type SocketIoPresetTransport = 'websocket' | 'polling';

export interface SocketIoPresetEmit {
  name: string;
  eventName: string;
  /** Raw JSON text as typed in the composer (a value or an array of args). */
  args: string;
  ack: boolean;
}

export interface SocketIoPresetOptions {
  autoReconnect?: boolean;
  reconnectionAttempts?: number;
  reconnectionDelay?: number;
  /** Handshake timeout, ms. */
  timeout?: number;
  forceNew?: boolean;
}

export interface SocketIoRequest {
  id: string;
  name: string;
  type: 'socketio';
  description?: string;
  url: string;
  namespace: string;
  path: string;
  /**
   * Handshake `auth` payload (the store's `auth` rows). Deliberately NOT named
   * `auth`: that key means `AuthConfig` on every other request kind, and
   * generic `'auth' in request` walks (redaction, keychain migration) would
   * mis-handle a row list. Every value is blanked on export.
   */
  handshakeAuth: KeyValue[];
  query: KeyValue[];
  /** Handshake headers (`extraHeaders` in the connection store). */
  headers: KeyValue[];
  transports: SocketIoPresetTransport[];
  /** Events listened to after connecting. */
  subscribedEvents: string[];
  /** Composer draft: the emit the panel opens with. */
  emit: Omit<SocketIoPresetEmit, 'name'>;
  /** Saved emits, stored unresolved. */
  templates: SocketIoPresetEmit[];
  options?: SocketIoPresetOptions;
}

export type StreamPresetRequest = WebSocketRequest | SocketIoRequest;
export type StreamPresetRequestType = StreamPresetRequest['type'];

export function isStreamPresetRequest(
  request: { type: string } | undefined
): request is StreamPresetRequest {
  return request?.type === 'websocket' || request?.type === 'socketio';
}

/** Connection-mode tab kinds that save as WebSocket / Socket.IO collection items. */
export function isStreamPresetMode(mode: string | undefined): mode is StreamPresetRequestType {
  return mode === 'websocket' || mode === 'socketio';
}
