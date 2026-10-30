/**
 * Binary-safe MQTT payload helpers (MQTT-2). Payloads and correlation data are
 * Binary Data (MQTT 5.0 §1.5.6): they cross IPC as UTF-8 text or base64, and
 * the composer lets the user type them as Text, JSON, Hex or Base64.
 */

import type { MqttBinaryEncoding } from '../../../../electron/types/electron-api';

export type MqttPayloadFormat = 'text' | 'json' | 'hex' | 'base64';

export const MQTT_PAYLOAD_FORMATS: ReadonlyArray<{ value: MqttPayloadFormat; label: string }> = [
  { value: 'text', label: 'Text' },
  { value: 'json', label: 'JSON' },
  { value: 'hex', label: 'Hex' },
  { value: 'base64', label: 'Base64' },
];

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Parse hex text (whitespace, `0x` prefixes and `:` separators allowed). */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/0x/gi, '').replace(/[\s:,-]/g, '');
  if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) {
    throw new Error('Hex payload must be an even number of hex digits');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

/** Normalise base64 text (strips whitespace, adds padding) and validate it. */
function canonicalBase64(text: string): string {
  const clean = text.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(padded) || clean.length % 4 === 1) {
    throw new Error('Base64 payload is not valid base64');
  }
  return padded;
}

/**
 * Convert composer text in `format` to its IPC form. Throws a user-facing
 * error for malformed JSON / hex / base64.
 */
export function encodeMqttPayload(
  text: string,
  format: MqttPayloadFormat
): { payload: string; payloadEncoding: MqttBinaryEncoding } {
  switch (format) {
    case 'json':
      try {
        JSON.parse(text);
      } catch (err) {
        throw new Error(`Payload is not valid JSON: ${err instanceof Error ? err.message : err}`);
      }
      return { payload: text, payloadEncoding: 'utf8' };
    case 'hex':
      return { payload: bytesToBase64(hexToBytes(text)), payloadEncoding: 'base64' };
    case 'base64':
      return { payload: canonicalBase64(text), payloadEncoding: 'base64' };
    default:
      return { payload: text, payloadEncoding: 'utf8' };
  }
}

/** Bytes carried by an IPC binary field. */
export function decodeMqttBinary(
  value: string,
  encoding: MqttBinaryEncoding | undefined
): Uint8Array {
  return encoding === 'base64' ? base64ToBytes(value) : new TextEncoder().encode(value);
}

/**
 * Render a received binary field for display: text stays text; non-UTF-8
 * bytes show as hex (default) or base64.
 */
export function displayMqttBinary(
  value: string,
  encoding: MqttBinaryEncoding | undefined,
  view: 'hex' | 'base64' = 'hex'
): string {
  if (encoding !== 'base64') return value;
  return view === 'base64' ? value : bytesToHex(base64ToBytes(value));
}

/** Byte length of an IPC binary field. */
export function mqttBinaryLength(value: string, encoding: MqttBinaryEncoding | undefined): number {
  return decodeMqttBinary(value, encoding).length;
}
