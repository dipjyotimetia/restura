// IPC channels: MQTT.
// Composed into IPC / EVENT / EVENT_PREFIX by ../channels.ts.

export const MQTT_IPC = {
  mqtt: {
    connect: 'mqtt:connect',
    publish: 'mqtt:publish',
    subscribe: 'mqtt:subscribe',
    unsubscribe: 'mqtt:unsubscribe',
    disconnect: 'mqtt:disconnect',
  },
} as const;

export const MQTT_EVENT_PREFIX = {
  mqtt: {
    connected: 'mqtt:connected:',
    message: 'mqtt:message:',
    error: 'mqtt:error:',
    subscribed: 'mqtt:subscribed:',
    unsubscribed: 'mqtt:unsubscribed:',
    close: 'mqtt:close:',
  },
} as const;
