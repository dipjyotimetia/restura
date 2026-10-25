// Single source of truth for IPC channel names shared between the Electron
// main process (handlers in electron/main/*) and the preload bridge
// (electron/main/preload.ts). Both sides import from here so renaming a
// channel is a compile error rather than a silent runtime break.
//
// - IPC: request/response (`ipcMain.handle`) and fire-and-forget
//   (`ipcMain.on`) channels invoked by the renderer.
// - EVENT: static main→renderer push channels.
// - EVENT_PREFIX + eventChannel(): templated per-connection main→renderer
//   channels (e.g. `grpc:data:<requestId>`).
// - CHANNEL_PREFIXES: the namespace allowlist enforced by preload's event
//   bridge (`channel.startsWith(prefix)`). This is a security boundary —
//   keep it here so the guard is defined once, not copy-pasted per protocol.
//
// The IPC / EVENT / EVENT_PREFIX groups live in per-area modules under
// `./channels/` so concurrent feature PRs don't collide in one file. Add a
// channel to the matching area module; this file only composes them (a new
// area module also needs its spread added below). CHANNEL_PREFIXES and
// VALID_EVENT_CHANNELS stay here because they are the security allowlists.

import { AI_EVENT_PREFIX, AI_IPC } from './channels/ai';
import { APP_EVENT, APP_IPC } from './channels/app';
import { GIT_IPC } from './channels/git';
import { GRPC_EVENT_PREFIX, GRPC_IPC } from './channels/grpc';
import { HTTP_IPC } from './channels/http';
import { KAFKA_EVENT_PREFIX, KAFKA_IPC } from './channels/kafka';
import { LOCAL_SERVICES_EVENT, LOCAL_SERVICES_IPC } from './channels/local-services';
import { MCP_EVENT_PREFIX, MCP_IPC } from './channels/mcp';
import { MQTT_EVENT_PREFIX, MQTT_IPC } from './channels/mqtt';
import { SECURITY_IPC } from './channels/security';
import { SOCKETIO_IPC } from './channels/socketio';
import { SSE_EVENT_PREFIX, SSE_IPC } from './channels/sse';
import { STORAGE_EVENT, STORAGE_IPC } from './channels/storage';
import { WEBSOCKET_EVENT_PREFIX, WEBSOCKET_IPC } from './channels/websocket';

export const IPC = {
  ...APP_IPC,
  ...HTTP_IPC,
  ...GRPC_IPC,
  ...WEBSOCKET_IPC,
  ...SOCKETIO_IPC,
  ...SSE_IPC,
  ...MCP_IPC,
  ...KAFKA_IPC,
  ...MQTT_IPC,
  ...STORAGE_IPC,
  ...SECURITY_IPC,
  ...GIT_IPC,
  ...AI_IPC,
  ...LOCAL_SERVICES_IPC,
} as const;

/** Static main→renderer push channels (not per-connection). */
export const EVENT = {
  ...APP_EVENT,
  ...STORAGE_EVENT,
  ...LOCAL_SERVICES_EVENT,
} as const;

/**
 * Prefixes for templated per-connection main→renderer channels. Combine with
 * a connection/request/stream id via {@link eventChannel}.
 */
export const EVENT_PREFIX = {
  ...GRPC_EVENT_PREFIX,
  ...WEBSOCKET_EVENT_PREFIX,
  ...SSE_EVENT_PREFIX,
  ...MCP_EVENT_PREFIX,
  ...KAFKA_EVENT_PREFIX,
  ...MQTT_EVENT_PREFIX,
  ...AI_EVENT_PREFIX,
} as const;

/** Build a templated event channel: `eventChannel('grpc:data:', id)`. */
export function eventChannel(prefix: string, id: string | number): string {
  return `${prefix}${id}`;
}

/**
 * Namespace prefixes preload's event bridge allowlists. A renderer may only
 * subscribe to channels under one of these prefixes — the guard lives here so
 * a typo can't silently weaken isolation for one protocol.
 */
export const CHANNEL_PREFIXES = {
  grpc: 'grpc:',
  ws: 'ws:',
  socketio: 'socketio:',
  sse: 'sse:',
  mcp: 'mcp:',
  kafka: 'kafka:',
  mqtt: 'mqtt:',
} as const;

/**
 * Top-level menu/app event channels the renderer may subscribe to via the
 * generic `window.electron.on(...)` bridge.
 */
export const VALID_EVENT_CHANNELS = [
  'menu:import',
  'menu:export',
  'menu:new-request',
  'menu:close-tab',
  'menu:reopen-tab',
  'menu:settings',
  'menu:report-bug',
  'app:focus',
  'app:check-updates',
] as const;

/** Flat list of every static `ipcMain.handle` / `ipcMain.on` channel. */
export const ALL_IPC_CHANNELS: readonly string[] = Object.values(IPC).flatMap((group) =>
  Object.values(group)
);
