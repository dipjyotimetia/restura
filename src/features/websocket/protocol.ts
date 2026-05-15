/**
 * WebSocket protocol module — metadata-only registration.
 *
 * WebSocket is a full-duplex, long-lived connection — there is no
 * `Request` shape for it in the type system. Connection state lives
 * directly in `useWebSocketStore` keyed by connection id, and frames
 * are sent/received through `websocketManager` (with native WebSocket on
 * web, Electron IPC when custom headers are required).
 *
 * This module exists so the registry catalog covers all five wire
 * protocols. Both `defaultRequest` and `runRequest` throw to point
 * future callers at the proper API (the WebSocketClient component +
 * websocketManager). When/if Restura adds a `WebSocketRequest` shape and
 * the runner grows a streaming/duplex contract, this stub gets replaced.
 */
import type { ProtocolModule } from '@/features/registry/types';

export const websocketProtocol: ProtocolModule = {
  id: 'websocket',
  label: 'WebSocket',
  tabType: 'websocket',
  // TODO(registry-streaming): WebSocket has no Request shape today; the
  // builder constructs WebSocketConnection records inside useWebSocketStore
  // rather than going through the request store. Once a WebSocketRequest
  // type is introduced this can return a sensible default.
  defaultRequest: () => {
    throw new Error(
      'WebSocket has no Request shape; create a connection via useWebSocketStore.'
    );
  },
  // TODO(registry-streaming): WebSocket is full-duplex and stateful. The
  // runner's single-shot Promise<Response> contract can't model frames
  // flowing in both directions over a persistent socket. WebSocketClient
  // drives websocketManager directly today.
  runRequest: async () => {
    throw new Error(
      'WebSocket is full-duplex and stateful; use WebSocketClient + websocketManager, not the registry runner.'
    );
  },
};
