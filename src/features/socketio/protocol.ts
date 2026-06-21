/**
 * Socket.IO protocol module — metadata-only registration.
 *
 * Socket.IO is a stateful, long-lived, event-driven connection. Like
 * WebSocket, it has no `Request` shape in the type system: connection state
 * lives in `useSocketIOStore` keyed by connection id, and events are
 * emitted/received through `socketioManager` (browser `socket.io-client` on
 * web, Electron IPC bridge on desktop).
 *
 * Both `defaultRequest` and `runRequest` throw to point future callers at
 * the proper API (the SocketIOClient component + socketioManager). If a
 * `SocketIORequest` shape and a streaming registry runner are added later,
 * this stub gets replaced.
 */
import type { ProtocolModule } from '@/features/registry/types';

export const socketioProtocol: ProtocolModule = {
  id: 'socketio',
  label: 'Socket.IO',
  tabType: 'socketio',
  defaultRequest: () => {
    throw new Error('Socket.IO has no Request shape; create a connection via useSocketIOStore.');
  },
  runRequest: async () => {
    throw new Error(
      'Socket.IO is event-driven and stateful; use SocketIOClient + socketioManager, not the registry runner.'
    );
  },
};
