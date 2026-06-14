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

// Structural slices of @kafkajs/confluent-schema-registry's SchemaRegistry, so
// this module stays electron-free and lib-import-free (and unit-testable with a
// tiny fake registry).
export interface SchemaEncoder {
  encode(registryId: number, payload: unknown): Promise<Buffer>;
}
export interface SchemaDecoder {
  decode(buffer: Buffer): Promise<unknown>;
}

/**
 * ENCODE one produce field (key or value) with a registry schema: parse the raw
 * string as JSON, then Confluent-encode it. Returns the wire Buffer, or an error
 * (invalid JSON, or the registry encode threw). `field` shapes the error text.
 */
export async function encodeSchemaField(
  registry: SchemaEncoder,
  schemaId: number,
  raw: string,
  field: 'key' | 'value'
): Promise<{ value: Buffer } | { error: string }> {
  const parsed = parseSchemaJson(raw, field);
  if ('error' in parsed) return parsed;
  try {
    return { value: await registry.encode(schemaId, parsed.value) };
  } catch (err) {
    const label = field === 'key' ? 'Key' : 'Value';
    return {
      error: `${label} schema encode failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * DECODE a consumed key/value Buffer to its display string: registry-decode when
 * it carries the Confluent wire framing (and a registry is configured), else read
 * as UTF-8. Falls back to raw text if decode throws (schema missing / not actually
 * registry-encoded).
 */
export async function decodeField(
  registry: SchemaDecoder | undefined,
  buf: Buffer
): Promise<string> {
  if (registry && isConfluentEncoded(buf)) {
    try {
      return valueToString(await registry.decode(buf));
    } catch {
      /* fall through to text */
    }
  }
  return valueToString(buf);
}
