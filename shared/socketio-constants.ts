/**
 * Constants shared between the renderer `socketioManager` and the Electron
 * `socketio-handler`. Pure data, no platform dependencies — lives in
 * `shared/` so both processes' tsconfigs can pick it up and the two paths
 * cannot drift on event names or IPC channel naming.
 */

/**
 * Socket.IO lifecycle events handled explicitly. The catch-all `onAny`
 * forwarder skips these so application events don't compete with our own
 * lifecycle signalling.
 */
export const SOCKETIO_RESERVED_EVENTS: ReadonlySet<string> = new Set([
  'connect',
  'disconnect',
  'connect_error',
  'reconnect',
  'reconnect_attempt',
  'reconnect_error',
  'reconnect_failed',
]);

/** IPC channel names. Single source of truth so handler and renderer can't drift. */
export const socketioChannels = {
  open: (id: string) => `socketio:open:${id}` as const,
  close: (id: string) => `socketio:close:${id}` as const,
  error: (id: string) => `socketio:error:${id}` as const,
  event: (id: string) => `socketio:event:${id}` as const,
  ack: (id: string) => `socketio:ack:${id}` as const,
  reconnectAttempt: (id: string) => `socketio:reconnect_attempt:${id}` as const,
  reconnect: (id: string) => `socketio:reconnect:${id}` as const,
  reconnectFailed: (id: string) => `socketio:reconnect_failed:${id}` as const,
} as const;

/** URL schemes a Socket.IO server may legitimately use. Mirror in `electron/main/ipc-validators.ts`. */
export const SOCKETIO_VALID_SCHEMES: ReadonlySet<string> = new Set([
  'http:',
  'https:',
  'ws:',
  'wss:',
]);
