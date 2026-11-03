// Per-schema-id encode/decode for the Confluent wire format
// (magic byte 0x00, 4-byte big-endian schema id, schema-type-specific body).
//
// AVRO bodies go through the registry library's avsc type (built with the
// int64 long hook), PROTOBUF and JSON through Restura's own codecs — see
// protobuf-codec.ts / json-schema-codec.ts for why the library's are not used.

import { coerceAvroPayload, normalizeAvroDecoded } from './avro-codec';
import { buildJsonSchemaCodec } from './json-schema-codec';
import { buildProtobufCodec } from './protobuf-codec';

type SchemaType = 'AVRO' | 'JSON' | 'PROTOBUF';

interface AvroTypeLike {
  toBuffer(value: unknown): Buffer;
  fromBuffer(buf: Buffer): unknown;
  isValid(value: unknown, opts?: { errorHook?: (path: string[]) => void }): boolean;
}

interface BodyCodec {
  type: SchemaType;
  encode(payload: unknown, messageName?: string): Buffer;
  decode(body: Buffer): unknown;
}

export interface SchemaCodecDeps {
  /** GET a registry path (bounded, guarded transport) and parse its JSON. */
  getJson(path: string): Promise<unknown>;
  /** The registry library's avsc type for an Avro schema id. */
  avroType(id: number): Promise<unknown>;
}

export interface SchemaCodecs {
  encode(id: number, payload: unknown, messageName?: string): Promise<Buffer>;
  decode(buffer: Buffer): Promise<unknown>;
}

interface ResolvedReference {
  name: string;
  schema: string;
}

const MAX_REFERENCES = 100;
const MAX_REFERENCE_DEPTH = 16;
const MAX_CODECS = 256;

function schemaTypeOf(value: unknown): SchemaType {
  return value === 'PROTOBUF' || value === 'JSON' ? value : 'AVRO';
}

function referencesOf(
  raw: Record<string, unknown>
): { name: string; subject: string; version: number }[] {
  if (!Array.isArray(raw.references)) return [];
  return (raw.references as Record<string, unknown>[]).flatMap((r) =>
    typeof r.name === 'string' && typeof r.subject === 'string' && typeof r.version === 'number'
      ? [{ name: r.name, subject: r.subject, version: r.version }]
      : []
  );
}

function schemaText(raw: unknown, what: string): Record<string, unknown> & { schema: string } {
  const body = (raw ?? {}) as Record<string, unknown>;
  if (typeof body.schema !== 'string') {
    throw new Error(`Schema Registry returned an unexpected response for ${what}.`);
  }
  return body as Record<string, unknown> & { schema: string };
}

function frame(id: number, body: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(0, 0);
  header.writeUInt32BE(id, 1);
  return Buffer.concat([header, body]);
}

export function createSchemaCodecs(deps: SchemaCodecDeps): SchemaCodecs {
  const codecs = new Map<number, Promise<BodyCodec>>();

  /** Resolve references dependency-first (each file before the files importing it). */
  async function resolveReferences(raw: Record<string, unknown>): Promise<ResolvedReference[]> {
    const out: ResolvedReference[] = [];
    const seen = new Set<string>();
    const visit = async (node: Record<string, unknown>, depth: number): Promise<void> => {
      for (const ref of referencesOf(node)) {
        const key = `${ref.name}\u0000${ref.subject}\u0000${ref.version}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (seen.size > MAX_REFERENCES || depth > MAX_REFERENCE_DEPTH) {
          throw new Error('Schema references are nested too deeply or are too many.');
        }
        const fetched = schemaText(
          await deps.getJson(
            `/subjects/${encodeURIComponent(ref.subject)}/versions/${encodeURIComponent(String(ref.version))}`
          ),
          `reference ${ref.subject} v${ref.version}`
        );
        await visit(fetched, depth + 1);
        out.push({ name: ref.name, schema: fetched.schema });
      }
    };
    await visit(raw, 0);
    return out;
  }

  async function build(id: number): Promise<BodyCodec> {
    const raw = schemaText(await deps.getJson(`/schemas/ids/${id}`), `schema id ${id}`);
    const type = schemaTypeOf(raw.schemaType);
    if (type === 'AVRO') {
      const avro = (await deps.avroType(id)) as AvroTypeLike;
      return {
        type,
        encode(payload) {
          const coerced = coerceAvroPayload(avro, payload);
          const paths: string[] = [];
          if (!avro.isValid(coerced, { errorHook: (path) => paths.push(path.join('.') || '$') })) {
            throw new Error(
              `Payload does not match the Avro schema at: ${paths.slice(0, 10).join(', ')}`
            );
          }
          return avro.toBuffer(coerced);
        },
        decode: (body) => normalizeAvroDecoded(avro.fromBuffer(body)),
      };
    }
    const references = await resolveReferences(raw);
    if (type === 'PROTOBUF') {
      const codec = buildProtobufCodec(raw.schema, references);
      return { type, encode: (p, m) => codec.encode(p, m), decode: (b) => codec.decode(b) };
    }
    const codec = buildJsonSchemaCodec(raw.schema, references);
    return { type, encode: (p) => codec.encode(p), decode: (b) => codec.decode(b) };
  }

  function codecFor(id: number): Promise<BodyCodec> {
    const cached = codecs.get(id);
    if (cached) return cached;
    if (codecs.size >= MAX_CODECS) {
      const oldest = codecs.keys().next();
      if (!oldest.done) codecs.delete(oldest.value);
    }
    const pending = build(id);
    codecs.set(id, pending);
    // A failed build (registry down, bad schema) is retried on the next use.
    pending.catch(() => {
      if (codecs.get(id) === pending) codecs.delete(id);
    });
    return pending;
  }

  return {
    async encode(id, payload, messageName) {
      if (!Number.isSafeInteger(id) || id <= 0 || id > 0xffffffff) {
        throw new Error(`Invalid schema id ${id}.`);
      }
      const codec = await codecFor(id);
      if (messageName && codec.type !== 'PROTOBUF') {
        throw new Error('A message type can only be chosen for Protobuf schemas.');
      }
      return frame(id, codec.encode(payload, messageName));
    },
    async decode(buffer) {
      if (buffer.length < 5 || buffer[0] !== 0) {
        throw new Error('Not a Schema Registry framed record.');
      }
      const codec = await codecFor(buffer.readUInt32BE(1));
      return codec.decode(buffer.subarray(5));
    },
  };
}
