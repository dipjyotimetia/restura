// IPC channels: HTTP.
// Composed into IPC / EVENT / EVENT_PREFIX by ../channels.ts.

export const HTTP_IPC = {
  http: {
    request: 'http:request',
    cancel: 'http:cancel',
  },
} as const;
