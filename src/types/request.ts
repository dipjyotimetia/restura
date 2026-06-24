import type { GrpcRequest } from './grpc';
import type { HttpRequest, Response } from './http';
import type { ScriptResult } from './scripts';
import type { SseRequest, McpRequest, StreamEventLike } from './streaming';

// Request Types
export type RequestType = 'http' | 'grpc' | 'sse' | 'mcp';

// Request Mode (used for UI mode switching)
// Kafka and MQTT are connection-based (no Request shape) and Electron-only —
// the picker still surfaces them in the web build but the page renders a
// "Desktop only" panel.
export type RequestMode =
  | 'http'
  | 'grpc'
  | 'websocket'
  | 'graphql'
  | 'sse'
  | 'mcp'
  | 'kafka'
  | 'mqtt'
  | 'socketio';

// Union type for any request
export type Request = HttpRequest | GrpcRequest | SseRequest | McpRequest;

// Multi-tab request tab
/**
 * Workspace modes that don't have a dedicated RequestType. They layer on top of
 * an HTTP placeholder tab via `RequestTab.modeOverride`; the actual connection
 * state lives in the per-protocol stores (`useWebSocketStore`, etc.).
 *
 * Derived from the existing unions so adding a future mode to `RequestMode`
 * without a corresponding `RequestType` propagates automatically.
 */
export type TabModeOverride = Exclude<RequestMode, RequestType>;

/**
 * Runtime companion to {@link TabModeOverride}. The `Record` makes the set of
 * connection-based modes exhaustive at compile time — adding a new
 * `TabModeOverride` without listing it here is a type error, so the UI call
 * sites that branch on "is this a connection-based mode?" can never silently
 * fall out of sync (the failure mode that previously shipped a protocol
 * missing from one of several hand-maintained `||` lists).
 */
const CONNECTION_MODES: Record<TabModeOverride, true> = {
  graphql: true,
  websocket: true,
  socketio: true,
  kafka: true,
  mqtt: true,
};

/** True when `mode` opens via `openTabWithMode` (a `modeOverride` tab) rather than a real `RequestType`. */
export function isConnectionMode(mode: string): mode is TabModeOverride {
  return mode in CONNECTION_MODES;
}

export interface RequestTab {
  id: string;
  request: Request;
  /** Last response received in this tab; persists across reloads. */
  response?: Response | null;
  /** Last script results (pre-request + test) for this tab's request. */
  scriptResult?: { preRequest?: ScriptResult; test?: ScriptResult } | null;
  /** Whether the request has unsaved changes vs the saved version (savedRequestId). */
  isDirty: boolean;
  /** If this tab was opened from a saved request in a collection, the saved request's id. */
  savedRequestId?: string;
  /**
   * Pseudo-mode marker. Present when the tab represents a WebSocket / Socket.IO
   * / Kafka / GraphQL session (none of which have their own RequestType). The
   * underlying `request` is an HTTP scaffold acting as a placeholder.
   */
  modeOverride?: TabModeOverride;
  /**
   * In-flight or recently completed streaming response. NOT persisted —
   * AsyncIterables aren't JSON-serializable and streams are inherently
   * transient. Stripped by `partialize` in `useRequestStore`.
   */
  streamingEvents?: AsyncIterable<StreamEventLike>;
}
