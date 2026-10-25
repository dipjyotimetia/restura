// IPC channels: Local mock server and browser-capture bridge.
// Composed into IPC / EVENT / EVENT_PREFIX by ../channels.ts.

export const LOCAL_SERVICES_IPC = {
  mock: {
    start: 'mock:start',
    stop: 'mock:stop',
    status: 'mock:status',
  },
  captureBridge: {
    start: 'capture-bridge:start',
    stop: 'capture-bridge:stop',
    status: 'capture-bridge:status',
  },
} as const;

export const LOCAL_SERVICES_EVENT = {
  // A captured browser session arrived over the loopback bridge and was
  // converted to an OpenCollection document for the renderer to import.
  captureReceived: 'capture-bridge:received',
} as const;
