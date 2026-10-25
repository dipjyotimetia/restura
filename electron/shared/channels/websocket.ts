// IPC channels: WebSocket.
// Composed into IPC / EVENT / EVENT_PREFIX by ../channels.ts.

export const WEBSOCKET_IPC = {
  ws: {
    connect: 'ws:connect',
    send: 'ws:send',
    disconnect: 'ws:disconnect',
    ping: 'ws:ping',
  },
} as const;

export const WEBSOCKET_EVENT_PREFIX = {
  ws: {
    open: 'ws:open:',
    message: 'ws:message:',
    error: 'ws:error:',
    close: 'ws:close:',
    pingReceived: 'ws:ping-received:',
    pong: 'ws:pong:',
  },
} as const;
