/**
 * Coerce a Kafka message key/value into the string the renderer displays.
 *
 * The plain string path passes through unchanged; a Schema-Registry-decoded
 * Avro/Protobuf/JSON value arrives as a parsed object and is JSON-serialized.
 * Dispatches on the runtime type, so it stays correct even though the registry
 * consumer is statically typed as `string` (the @platformatic/kafka registry
 * generics are intentionally loose). Kept in its own electron-free module so it
 * can be unit-tested without importing the IPC handler's `electron` deps.
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
