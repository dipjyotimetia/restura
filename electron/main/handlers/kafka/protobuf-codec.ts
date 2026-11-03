// Confluent Schema Registry Protobuf codec — the Confluent framing around
// @bufbuild/protobuf.
//
// Replaces the @kafkajs/confluent-schema-registry Protobuf path, which does not
// implement the Confluent framing: it writes no message-index array after the
// schema id (so Confluent Java/Go/Python/.NET deserializers cannot read what we
// produce), ignores the index array on decode (always the first message), picks
// the "first" type by object-key order (a registry that normalises enums first
// makes every such schema fail with "no such type"), and cannot resolve
// google/protobuf/* imports.
//
// Everything Protobuf-specific is delegated to the libraries the gRPC client
// already uses: `.proto` text (schema + registry references) is compiled by the
// shared `compileProtoFiles` (protobufjs parse → bufbuild descriptors with
// canonical well-known types), and values go through bufbuild's proto3 JSON
// mapping (`fromJson` / `toJson`) and binary codec (`toBinary` / `fromBinary`).
// Only the Confluent message-index framing lives here
// (https://docs.confluent.io/platform/current/schema-registry/fundamentals/serdes-develop/index.html#wire-format):
//   zigzag varint count, then that many zigzag varint indexes (the path to the
//   message type, top-level index first); the common [0] path is the single
//   byte 0x00. Then the protobuf payload.
//
// JSON mapping is proto3 canonical JSON with `.proto` field names on output
// (JSON names are accepted on input): 64-bit integers as strings, enums as
// names, bytes as Base64, Timestamp/Duration/wrappers/Struct in their canonical
// JSON forms, implicit defaults emitted.

import {
  create,
  createFileRegistry,
  type DescMessage,
  fromBinary,
  fromJson,
  type JsonValue,
  toBinary,
  toJson,
} from '@bufbuild/protobuf';
import { BinaryReader, BinaryWriter } from '@bufbuild/protobuf/wire';
import { type DescriptorProto, FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt';
import { compileProtoFiles } from '@shared/protocol/grpc-proto-compiler';
import { describeUnknownFields, findUnknownJsonFields } from '@shared/protocol/grpc-unknown-fields';

export interface ProtobufReference {
  name: string;
  schema: string;
}

export interface ProtobufCodec {
  /** Fully-qualified names of the schema file's messages, in Confluent index order. */
  readonly messageNames: readonly string[];
  /** Encode a JSON value; returns message-indexes + payload (no magic/id). */
  encode(payload: unknown, messageName?: string): Buffer;
  /** Decode message-indexes + payload (no magic/id) to a JSON value. */
  decode(body: Buffer): unknown;
}

/** Path the registry schema itself is compiled under (references keep their names). */
const MAIN_FILE = '__restura_registry_schema__.proto';
const MAX_INDEX_DEPTH = 32;

export function encodeMessageIndexes(path: readonly number[]): Buffer {
  if (path.length === 1 && path[0] === 0) return Buffer.from([0]);
  const writer = new BinaryWriter().sint32(path.length);
  for (const index of path) writer.sint32(index);
  return Buffer.from(writer.finish());
}

export function decodeMessageIndexes(body: Buffer): { path: number[]; offset: number } {
  const reader = new BinaryReader(body);
  const count = reader.sint32();
  if (count === 0) return { path: [0], offset: reader.pos };
  if (count < 0 || count > MAX_INDEX_DEPTH) {
    throw new Error(`Invalid Protobuf message-index count ${count}.`);
  }
  const path: number[] = [];
  for (let i = 0; i < count; i++) {
    const index = reader.sint32();
    if (index < 0) throw new Error('Invalid negative Protobuf message index.');
    path.push(index);
  }
  return { path, offset: reader.pos };
}

/**
 * JSON.parse has already rounded integers beyond 2^53, and fromJson accepts the
 * rounded number for 64-bit fields, so refuse them up front (pass a string).
 */
function findUnsafeInteger(value: unknown, path: string, depth = 0): string | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) && !Number.isSafeInteger(value) ? path || '$' : undefined;
  }
  if (depth > 64 || !value || typeof value !== 'object') return undefined;
  for (const [key, child] of Object.entries(value)) {
    const hit = findUnsafeInteger(
      child,
      Array.isArray(value) ? `${path}[${key}]` : path ? `${path}.${key}` : key,
      depth + 1
    );
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Build the codec for a registry Protobuf schema plus its resolved references.
 * Throws when the schema does not compile (parse error, unresolvable type or
 * import).
 */
export function buildProtobufCodec(
  schema: string,
  references: readonly ProtobufReference[] = []
): ProtobufCodec {
  const seen = new Set<string>();
  const files = [
    ...references.filter((r) => !seen.has(r.name) && seen.add(r.name)),
    { name: MAIN_FILE, schema },
  ].map((f) => ({ path: f.name, content: f.schema }));
  const registry = createFileRegistry(
    create(FileDescriptorSetSchema, { file: compileProtoFiles(files) })
  );
  const file = registry.getFile(MAIN_FILE);
  if (!file) throw new Error('Protobuf schema could not be compiled.');
  if (file.proto.messageType.length === 0) {
    throw new Error('Protobuf schema defines no message types.');
  }

  // Message indexes follow protoc's message_type / nested_type order, where
  // map-entry types count too. protobufjs-derived descriptors list map entries
  // before explicit nested messages, so order explicit messages first (protoc
  // order whenever nested messages are declared before map fields, which is
  // how registries print normalised schemas).
  const prefix = file.proto.package ? `${file.proto.package}.` : '';
  const messageNames: string[] = [];
  const pathByName = new Map<string, number[]>();
  const nameByPath = new Map<string, string>();
  const walk = (types: readonly DescriptorProto[], parent: string, path: number[]) => {
    const ordered = [
      ...types.filter((t) => !t.options?.mapEntry),
      ...types.filter((t) => t.options?.mapEntry),
    ];
    ordered.forEach((type, index) => {
      const fullName = `${parent}${type.name}`;
      const nextPath = [...path, index];
      nameByPath.set(nextPath.join(','), fullName);
      if (!type.options?.mapEntry) {
        messageNames.push(fullName);
        pathByName.set(fullName, nextPath);
      }
      if (nextPath.length < MAX_INDEX_DEPTH) walk(type.nestedType, `${fullName}.`, nextPath);
    });
  };
  walk(file.proto.messageType, prefix, []);

  const message = (typeName: string): DescMessage => {
    const desc = registry.getMessage(typeName);
    if (!desc) throw new Error(`Protobuf message "${typeName}" is not in the schema.`);
    return desc;
  };
  const messageAt = (path: readonly number[]): DescMessage => {
    const name = nameByPath.get(path.join(','));
    if (!name) throw new Error(`Protobuf message index [${path.join(', ')}] is not in the schema.`);
    return message(name);
  };
  const resolvePath = (messageName: string | undefined): number[] => {
    if (!messageName) return [0];
    const bare = messageName.replace(/^\./, '');
    const path = pathByName.get(bare) ?? pathByName.get(`${prefix}${bare}`);
    if (path) return path;
    throw new Error(
      `Protobuf message "${messageName}" is not defined in the schema (${messageNames.join(', ')}).`
    );
  };
  const toDisplay = (desc: DescMessage, bytes: Uint8Array): unknown =>
    toJson(desc, fromBinary(desc, bytes), { alwaysEmitImplicit: true, useProtoFieldName: true });

  return {
    messageNames,
    encode(payload, messageName) {
      const path = resolvePath(messageName);
      const desc = messageAt(path);
      const unknown = findUnknownJsonFields(desc, payload);
      if (unknown.length > 0) {
        throw new Error(`Unknown field(s) in ${desc.typeName}: ${describeUnknownFields(unknown)}`);
      }
      const unsafe = findUnsafeInteger(payload, '');
      if (unsafe) {
        throw new Error(
          `${unsafe}: integer exceeds JSON number precision; pass 64-bit values as strings`
        );
      }
      const value = fromJson(desc, payload as JsonValue);
      return Buffer.concat([encodeMessageIndexes(path), Buffer.from(toBinary(desc, value))]);
    },
    decode(body) {
      try {
        const { path, offset } = decodeMessageIndexes(body);
        return toDisplay(messageAt(path), body.subarray(offset));
      } catch (strictError) {
        // Legacy frames with no message-index array (KafkaJS'
        // @kafkajs/confluent-schema-registry, and Restura before this codec)
        // carry the first message type's payload right after the schema id.
        try {
          return toDisplay(messageAt([0]), body);
        } catch {
          throw strictError;
        }
      }
    },
  };
}
