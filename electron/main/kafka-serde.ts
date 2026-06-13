// Kafka serde helpers — the encode (produce) / decode (consume) edge of the
// Confluent Schema Registry integration (@kafkajs/confluent-schema-registry).
// Kept electron-free so both sides can be unit-tested without importing the IPC
// handler's `electron` deps.

/**
 * DECODE: coerce a consumed message key/value into the string the renderer
 * displays. A plain value passes through unchanged; a registry-decoded
 * Avro/Protobuf/JSON value arrives as a parsed object and is JSON-serialized; a
 * raw Buffer is read as UTF-8. Dispatches on the runtime type so it stays correct
 * across the plain (string/Buffer) and registry-decoded (object) paths.
 */
export function valueToString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) return Buffer.from(v).toString();
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export type ParsedSchemaJson = { value: unknown } | { error: string };

/**
 * Parse a schema-encoded field's raw string into the value the registry encoder
 * expects — Avro/Protobuf/JSON encoders take a parsed value, not a raw string.
 * Reused for both the key and value produce paths; `field` only shapes the error.
 */
export function parseSchemaJson(raw: string, field: 'key' | 'value' = 'value'): ParsedSchemaJson {
  try {
    return { value: JSON.parse(raw) };
  } catch {
    return { error: `Schema-encoded ${field} must be valid JSON.` };
  }
}

/**
 * True when a consumed key/value Buffer carries the Confluent wire framing
 * (magic byte 0x00 + 4-byte big-endian schema id), i.e. it should be decoded via
 * the Schema Registry rather than read as UTF-8. Plain (non-registry) payloads
 * fail the check and pass through as text.
 */
export function isConfluentEncoded(buf: Uint8Array): boolean {
  return buf.length >= 5 && buf[0] === 0x00;
}
