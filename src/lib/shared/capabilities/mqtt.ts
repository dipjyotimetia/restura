// Capability rows: MQTT.
// Order is significant: it is the row order of docs/CAPABILITY_MATRIX.md.
import type { CapabilityRow } from './types';

export const MQTT_CAPABILITIES = {
  'mqtt.basic': {
    label: 'MQTT publish / subscribe',
    web: false,
    desktop: true,
    notes: 'Native broker protocol over raw TCP/TLS; no browser TCP',
  },
} as const satisfies Record<string, CapabilityRow>;
