/**
 * MQTT 5.0 reason-code names (§2.4, Table 2-6) used to explain CONNACK /
 * DISCONNECT / SUBACK outcomes in the message log (MQTT-6).
 */
const REASON_CODE_NAMES: Readonly<Record<number, string>> = {
  0x00: 'Normal disconnection',
  0x04: 'Disconnect with Will Message',
  0x10: 'No matching subscribers',
  0x11: 'No subscription existed',
  0x18: 'Continue authentication',
  0x19: 'Re-authenticate',
  0x80: 'Unspecified error',
  0x81: 'Malformed Packet',
  0x82: 'Protocol Error',
  0x83: 'Implementation specific error',
  0x84: 'Unsupported Protocol Version',
  0x85: 'Client Identifier not valid',
  0x86: 'Bad User Name or Password',
  0x87: 'Not authorized',
  0x88: 'Server unavailable',
  0x89: 'Server busy',
  0x8a: 'Banned',
  0x8b: 'Server shutting down',
  0x8c: 'Bad authentication method',
  0x8d: 'Keep Alive timeout',
  0x8e: 'Session taken over',
  0x8f: 'Topic Filter invalid',
  0x90: 'Topic Name invalid',
  0x91: 'Packet Identifier in use',
  0x92: 'Packet Identifier not found',
  0x93: 'Receive Maximum exceeded',
  0x94: 'Topic Alias invalid',
  0x95: 'Packet too large',
  0x96: 'Message rate too high',
  0x97: 'Quota exceeded',
  0x98: 'Administrative action',
  0x99: 'Payload format invalid',
  0x9a: 'Retain not supported',
  0x9b: 'QoS not supported',
  0x9c: 'Use another server',
  0x9d: 'Server moved',
  0x9e: 'Shared Subscriptions not supported',
  0x9f: 'Connection rate exceeded',
  0xa0: 'Maximum connect time',
  0xa1: 'Subscription Identifiers not supported',
  0xa2: 'Wildcard Subscriptions not supported',
};

function hex(code: number): string {
  return `0x${code.toString(16).toUpperCase().padStart(2, '0')}`;
}

/** `"Session taken over (0x8E)"`; unknown codes render as `"Reason code 0xNN"`. */
export function mqttReasonCodeName(code: number): string {
  const name = REASON_CODE_NAMES[code];
  return name ? `${name} (${hex(code)})` : `Reason code ${hex(code)}`;
}

/** Log line for a broker-initiated DISCONNECT. */
export function describeServerDisconnect(event: {
  reasonCode: number;
  reasonString?: string;
  serverReference?: string;
}): string {
  let line = `Disconnected by server: ${mqttReasonCodeName(event.reasonCode)}`;
  if (event.reasonString) line += ` — ${event.reasonString}`;
  if (event.serverReference) line += ` (server reference: ${event.serverReference})`;
  return line;
}
