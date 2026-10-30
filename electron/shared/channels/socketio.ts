// IPC channels: Socket.IO.
// Composed into IPC / EVENT / EVENT_PREFIX by ../channels.ts.

export const SOCKETIO_IPC = {
  socketio: {
    connect: 'socketio:connect',
    emit: 'socketio:emit',
    replyAck: 'socketio:reply-ack',
    disconnect: 'socketio:disconnect',
  },
} as const;

// Socket.IO event channels are NOT defined here (no SOCKETIO_EVENT_PREFIX).
// They have a pre-existing single source of truth in
// `shared/socketio-constants.ts` (`socketioChannels`), shared by the
// renderer's socketioManager and the Electron handler. Don't duplicate them —
// the actual names use snake_case (`reconnect_attempt`).
