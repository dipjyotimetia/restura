// IPC channels: Server-Sent Events.
// Composed into IPC / EVENT / EVENT_PREFIX by ../channels.ts.

export const SSE_IPC = {
  sse: {
    connect: 'sse:connect',
    disconnect: 'sse:disconnect',
  },
} as const;

export const SSE_EVENT_PREFIX = {
  sse: {
    open: 'sse:open:',
    event: 'sse:event:',
    error: 'sse:error:',
    close: 'sse:close:',
  },
} as const;
