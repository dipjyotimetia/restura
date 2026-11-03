// Per-schema-id encode/decode for the Confluent wire format
// (magic byte 0x00, 4-byte big-endian schema id, schema-type-specific body).
//
// AVRO bodies go through the registry library's avsc type (built with the
// int64 long hook), PROTOBUF and JSON through Restura's own codecs — see
// protobuf-codec.ts / json-schema-codec.ts for why the library's are not used.
// Encode takes the user's JSON text so each codec can parse it without losing
// precision (JSON.parse rounds integers beyond 2^53).

import { fromBinary } from '@bufbuild/protobuf';
import { FileDescriptorProtoSchema } from '@bufbuild/protobuf/wkt';
import { coerceAvroPayload, normalizeAvroDecoded } from './avro-codec';
import { buildJsonSchemaCodec } from './json-schema-codec';
import {
  buildProtobufCodec,
  buildProtobufCodecFromDescriptors,
  type ProtobufDescriptorReference,
} from './protobuf-codec';
import { type AvscTypeLike, parseJsonExact, type SchemaReference } from './schema-types';

type SchemaType = 'AVRO' | 'JSON' | 'PROTOBUF';

interface BodyCodec {
  type: SchemaType;
  encode(json: string, messageName?: string): Buffer;
  decode(body: Buffer): unknown;
}

export interface SchemaCodecDeps {
  /** GET a registry path (bounded, guarded transport) and parse its JSON. */
  getJson(path: string): Promise<unknown>;
  /** The registry library's avsc type for an Avro schema id. */
  avroType(id: number): Promise<unknown>;
}

export interface SchemaCodecs {
  /** Encode JSON text with schema `id`; `messageName` picks a Protobuf message type. */
  encode(id: number, json: string, messageName?: string): Promise<Buffer>;
  decode(buffer: Buffer): Promise<unknown>;
}

interface RawSchema {
  schema: string;
  schemaType?: unknown;
  references?: unknown;
}

interface RegistryReference {
  name: string;
  subject: string;
  version: number;
}

const MAX_REFERENCES = 100;
const MAX_REFERENCE_DEPTH = 16;
const MAX_CODECS = 256;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function schemaTypeOf(value: unknown): SchemaType {
  return value === 'PROTOBUF' || value === 'JSON' ? value : 'AVRO';
}

function referencesOf(raw: RawSchema): RegistryReference[] {
  if (!Array.isArray(raw.references)) return [];
  return (raw.references as Record<string, unknown>[]).flatMap((r) =>
    typeof r.name === 'string' && typeof r.subject === 'string' && typeof r.version === 'number'
      ? [{ name: r.name, subject: r.subject, version: r.version }]
      : []
  );
}

function asRawSchema(raw: unknown, what: string): RawSchema {
  const body = (raw ?? {}) as Record<string, unknown>;
  if (typeof body.schema !== 'string') {
    throw new Error(`Schema Registry returned an unexpected response for ${what}.`);
  }
  return body as unknown as RawSchema;
}

/** A registry-served FileDescriptorProto (`format=serialized`), or undefined for text. */
function descriptorOf(raw: RawSchema) {
  const text = raw.schema.trim();
  if (text === '' || !BASE64_RE.test(text)) return undefined;
  return fromBinary(FileDescriptorProtoSchema, Buffer.from(text, 'base64'));
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
  async function resolveReferences(
    root: RawSchema,
    query: string
  ): Promise<{ name: string; raw: RawSchema }[]> {
    const out: { name: string; raw: RawSchema }[] = [];
    const seen = new Set<string>();
    const visit = async (node: RawSchema, depth: number): Promise<void> => {
      for (const ref of referencesOf(node)) {
        const key = `${ref.name}\u0000${ref.subject}\u0000${ref.version}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (seen.size > MAX_REFERENCES || depth > MAX_REFERENCE_DEPTH) {
          throw new Error('Schema references are nested too deeply or are too many.');
        }
        const fetched = asRawSchema(
          await deps.getJson(
            `/subjects/${encodeURIComponent(ref.subject)}/versions/${encodeURIComponent(String(ref.version))}${query}`
          ),
          `reference ${ref.subject} v${ref.version}`
        );
        await visit(fetched, depth + 1);
        out.push({ name: ref.name, raw: fetched });
      }
    };
    await visit(root, 0);
    return out;
  }

  const textReferences = async (raw: RawSchema): Promise<SchemaReference[]> =>
    (await resolveReferences(raw, '')).map((r) => ({ name: r.name, schema: r.raw.schema }));

  /** Registry-compiled descriptors, when the registry serves them (Confluent, Redpanda). */
  async function protobufFromDescriptors(id: number) {
    const raw = asRawSchema(
      await deps.getJson(`/schemas/ids/${id}?format=serialized`),
      `schema id ${id}`
    );
    const main = descriptorOf(raw);
    if (!main) return undefined;
    const references: ProtobufDescriptorReference[] = [];
    for (const ref of await resolveReferences(raw, '?format=serialized')) {
      const proto = descriptorOf(ref.raw);
      if (!proto) return undefined;
      references.push({ name: ref.name, proto });
    }
    return buildProtobufCodecFromDescriptors(main, references);
  }

  async function build(id: number): Promise<BodyCodec> {
    const raw = asRawSchema(await deps.getJson(`/schemas/ids/${id}`), `schema id ${id}`);
    const type = schemaTypeOf(raw.schemaType);
    if (type === 'AVRO') {
      const avro = (await deps.avroType(id)) as AvscTypeLike;
      return {
        type,
        encode(json) {
          const coerced = coerceAvroPayload(avro, parseJsonExact(json));
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
    if (type === 'PROTOBUF') {
      // Prefer the registry's own descriptors (exact message indexes); fall
      // back to compiling the text when the registry cannot serve them.
      const codec =
        (await protobufFromDescriptors(id).catch(() => undefined)) ??
        buildProtobufCodec(raw.schema, await textReferences(raw));
      return { type, encode: (j, m) => codec.encode(j, m), decode: (b) => codec.decode(b) };
    }
    const codec = buildJsonSchemaCodec(raw.schema, await textReferences(raw));
    return { type, encode: (j) => codec.encode(j), decode: (b) => codec.decode(b) };
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
    async encode(id, json, messageName) {
      if (!Number.isSafeInteger(id) || id <= 0 || id > 0xffffffff) {
        throw new Error(`Invalid schema id ${id}.`);
      }
      const codec = await codecFor(id);
      if (messageName && codec.type !== 'PROTOBUF') {
        throw new Error('A message type can only be chosen for Protobuf schemas.');
      }
      return frame(id, codec.encode(json, messageName));
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
