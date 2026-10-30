// Capability rows: MQTT.
// Order is significant: it is the row order of docs/CAPABILITY_MATRIX.md.
import type { CapabilityRow } from './types';

export const MQTT_CAPABILITIES = {
  'mqtt.basic': {
    label: 'MQTT publish / subscribe',
    web: false,
    desktop: true,
    notes:
      'Native broker protocol (MQTT 3.1.1 / 5.0) over raw TCP/TLS or WebSocket; broker hostnames are DNS-checked against the private-IP / localhost policy and the dial is pinned; password and TLS passphrase are SecretRef handles resolved in main, TLS files are read in main; no browser TCP',
  },
  'mqtt.websocket': {
    label: 'MQTT over WebSocket (ws:// / wss://)',
    web: false,
    desktop: true,
    notes:
      'Same broker guard, DNS pinning and Settings TLS policy as mqtt:// / mqtts://; any configured proxy fails closed for WebSocket transports (SOCKS is honoured for mqtt:// / mqtts:// only)',
  },
  'mqtt.binaryPayloads': {
    label: 'MQTT binary payloads (Text / JSON / Hex / Base64)',
    web: false,
    desktop: true,
    notes:
      'Payloads and correlation data cross IPC as UTF-8 or base64 — non-UTF-8 bytes are shown as hex/base64, never lossy-decoded',
  },
  'mqtt.v5Properties': {
    label: 'MQTT 5 properties (CONNECT, Will, publish, subscription options)',
    web: false,
    desktop: true,
    notes:
      'CONNECT properties incl. initial enhanced-auth method/data (multi-step AUTH challenges are reported as errors), server-assigned client IDs, Will properties, payload format indicator, topic alias (bounded by CONNACK maximum), No Local / Retain As Published / Retain Handling / subscription identifier, server DISCONNECT reason codes',
  },
  'mqtt.requestResponse': {
    label: 'MQTT 5 request/response with round-trip latency',
    web: false,
    desktop: true,
    notes:
      'Publishes with a generated response topic + correlation data, waits in main for the reply matched on raw correlation bytes; timeout and cancel supported',
  },
} as const satisfies Record<string, CapabilityRow>;
