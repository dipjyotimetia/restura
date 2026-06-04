// Kafka serde helpers — the symmetric encode (produce) / decode (consume) edge
// of the Schema Registry integration. Kept electron-free so both sides can be
// unit-tested without importing the IPC handler's `electron` deps.

/**
 * DECODE: coerce a consumed message key/value into the string the renderer
 * displays. A plain value passes through unchanged; a registry-decoded
 * Avro/Protobuf/JSON value arrives as a parsed object and is JSON-serialized.
 * Dispatches on the runtime type, so it stays correct even though the registry
 * consumer is statically typed `string` (the @platformatic/kafka registry
 * generics are intentionally loose).
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

export type SchemaValue =
  | { value: unknown; metadata: { schemas: { value: number } } }
  | { error: string };

/**
 * ENCODE: build the value + registry metadata for a schema-encoded produce.
 * The value must be valid JSON — Avro/Protobuf/JSON encoders take a parsed
 * object, not a raw string — and `metadata.schemas.value` tells the registry
 * which schema to encode with. Returns an `error` when the value isn't JSON.
 */
export function buildSchemaValue(value: string, schemaId: number): SchemaValue {
  try {
    return { value: JSON.parse(value), metadata: { schemas: { value: schemaId } } };
  } catch {
    return { error: 'Schema-encoded value must be valid JSON.' };
  }
}
