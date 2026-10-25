// IPC channels: gRPC.
// Composed into IPC / EVENT / EVENT_PREFIX by ../channels.ts.

export const GRPC_IPC = {
  grpc: {
    request: 'grpc:request',
    reflect: 'grpc:reflect',
    startStream: 'grpc:start-stream',
    sendMessage: 'grpc:send-message',
    endStream: 'grpc:end-stream',
    cancelStream: 'grpc:cancel-stream',
  },
} as const;

export const GRPC_EVENT_PREFIX = {
  grpc: {
    data: 'grpc:data:',
    error: 'grpc:error:',
    status: 'grpc:status:',
  },
} as const;
