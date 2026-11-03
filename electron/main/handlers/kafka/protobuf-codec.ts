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
// Everything Protobuf-specific is bufbuild — the stack the gRPC client uses:
//  - Descriptors come, in order of preference, from the registry itself
//    (`?format=serialized`: the FileDescriptorProto the registry compiled, so
//    message indexes match what Confluent's own deserializers resolve), or from
//    compiling the schema text with the shared `compileProtoFiles`.
//  - Values go through bufbuild's proto3 JSON mapping (`fromJson` / `toJson`,
//    with the file registry so `google.protobuf.Any` resolves) and binary codec.
// Only the Confluent message-index framing lives here
// (https://docs.confluent.io/platform/current/schema-registry/fundamentals/serdes-develop/index.html#wire-format):
//   zigzag varint count, then that many zigzag varint indexes (the path to the
//   message type, top-level index first); the common [0] path is the single
//   byte 0x00. Then the protobuf payload.
//
// JSON mapping is proto3 canonical JSON with `.proto` field names on output
// (JSON names are accepted on input): 64-bit integers as strings, enums as
// names, bytes as Base64, Timestamp/Duration/wrappers/Struct/Any in their
// canonical JSON forms, implicit defaults emitted. Input integer literals beyond
// 2^53 keep their exact digits (parsed as text, which fromJson accepts).

import {
  create,
  createFileRegistry,
  type DescField,
  type DescMessage,
  type FileRegistry,
  fromBinary,
  fromJson,
  type JsonValue,
  ScalarType,
  toBinary,
  toJson,
} from '@bufbuild/protobuf';
import { BinaryReader, BinaryWriter } from '@bufbuild/protobuf/wire';
import {
  type DescriptorProto,
  type FileDescriptorProto,
  FileDescriptorSetSchema,
} from '@bufbuild/protobuf/wkt';
import {
  compileProtoFiles,
  toJsonName,
  wellKnownFileProto,
} from '@shared/protocol/grpc-proto-compiler';
import { describeUnknownFields, findUnknownJsonFields } from '@shared/protocol/grpc-unknown-fields';
import { BigIntLiteral, parseJsonExact, type SchemaReference } from './schema-types';

export interface ProtobufCodec {
  /** Fully-qualified names of the schema file's messages, in Confluent index order. */
  readonly messageNames: readonly string[];
  /** Encode JSON text; returns message-indexes + payload (no magic/id). */
  encode(json: string, messageName?: string): Buffer;
  /** Decode message-indexes + payload (no magic/id) to a JSON value. */
  decode(body: Buffer): unknown;
}

/** A registry-compiled FileDescriptorProto and its import name. */
export interface ProtobufDescriptorReference {
  name: string;
  proto: FileDescriptorProto;
}

/** Path the registry schema itself is registered under (references keep their names). */
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

const INT64_SCALARS = new Set<ScalarType>([
  ScalarType.INT64,
  ScalarType.UINT64,
  ScalarType.FIXED64,
  ScalarType.SFIXED64,
  ScalarType.SINT64,
]);
const INT64_WRAPPERS = new Set(['google.protobuf.Int64Value', 'google.protobuf.UInt64Value']);

/**
 * Resolve {@link BigIntLiteral}s against the message type: exact text for
 * 64-bit integer fields (fromJson accepts decimal strings), a number anywhere
 * else (double/float, Struct/Value, unknown keys).
 */
function resolveLiterals(desc: DescMessage | undefined, value: unknown, depth = 0): unknown {
  if (value instanceof BigIntLiteral) return value.toNumber();
  if (depth > 64 || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => resolveLiterals(undefined, v, depth + 1));
  const typed = desc && !desc.typeName.startsWith('google.protobuf.') ? desc : undefined;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const field = typed?.fields.find((f) => f.name === key || f.jsonName === key);
    out[key] = field
      ? resolveField(field, child, depth + 1)
      : resolveLiterals(undefined, child, depth + 1);
  }
  return out;
}

function resolveScalar(scalar: ScalarType, value: unknown, depth: number): unknown {
  if (value instanceof BigIntLiteral)
    return INT64_SCALARS.has(scalar) ? value.source : value.toNumber();
  return resolveLiterals(undefined, value, depth);
}

function resolveMessage(desc: DescMessage, value: unknown, depth: number): unknown {
  if (value instanceof BigIntLiteral) {
    return INT64_WRAPPERS.has(desc.typeName) ? value.source : value.toNumber();
  }
  return resolveLiterals(desc, value, depth);
}

function resolveField(field: DescField, value: unknown, depth: number): unknown {
  switch (field.fieldKind) {
    case 'scalar':
      return resolveScalar(field.scalar, value, depth);
    case 'message':
      return resolveMessage(field.message, value, depth);
    case 'list':
      return Array.isArray(value)
        ? value.map((v) =>
            field.listKind === 'scalar'
              ? resolveScalar(field.scalar, v, depth + 1)
              : field.listKind === 'message'
                ? resolveMessage(field.message, v, depth + 1)
                : resolveLiterals(undefined, v, depth + 1)
          )
        : resolveLiterals(undefined, value, depth);
    case 'map':
      return value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).map(([k, v]) => [
              k,
              field.mapKind === 'scalar'
                ? resolveScalar(field.scalar, v, depth + 1)
                : field.mapKind === 'message'
                  ? resolveMessage(field.message, v, depth + 1)
                  : resolveLiterals(undefined, v, depth + 1),
            ])
          )
        : resolveLiterals(undefined, value, depth);
    default:
      return resolveLiterals(undefined, value, depth);
  }
}

const isWellKnown = (name: string) => wellKnownFileProto(name) !== undefined;

const TYPE_GROUP = 10;
const TYPE_MESSAGE = 11;
const TYPE_ENUM = 14;

/** Fully-qualified (leading-dot) message and enum names a file declares. */
function declaredTypes(file: FileDescriptorProto, out: Map<string, number>): void {
  const pkg = file.package ? `.${file.package}` : '';
  const walk = (types: readonly DescriptorProto[], prefix: string) => {
    for (const type of types) {
      const name = `${prefix}.${type.name}`;
      out.set(name, TYPE_MESSAGE);
      for (const e of type.enumType) out.set(`${name}.${e.name}`, TYPE_ENUM);
      walk(type.nestedType, name);
    }
  };
  for (const e of file.enumType) out.set(`${pkg}.${e.name}`, TYPE_ENUM);
  walk(file.messageType, pkg);
}

/** Protobuf scoping: a relative type name resolves innermost-scope first. */
function qualifyTypeName(
  typeName: string,
  scope: string,
  known: Map<string, number>
): string | undefined {
  if (typeName.startsWith('.')) return known.has(typeName) ? typeName : undefined;
  for (let at = scope; ; at = at.slice(0, Math.max(0, at.lastIndexOf('.')))) {
    const candidate = `${at}.${typeName}`;
    if (known.has(candidate)) return candidate;
    if (at === '') return undefined;
  }
}

/**
 * Registry-served descriptors can leave out what protoc always sets: json_name
 * (bufbuild reads an empty one verbatim), the field `type` for message/enum
 * fields (unset reads as TYPE_DOUBLE), and fully-qualified type names (Redpanda
 * writes e.g. map entries relative). Fill them in from the declared types.
 */
function repairDescriptor(
  types: readonly DescriptorProto[],
  scope: string,
  known: Map<string, number>
): void {
  for (const type of types) {
    const name = `${scope}.${type.name}`;
    for (const field of type.field) {
      if (!field.jsonName) field.jsonName = toJsonName(field.name);
      if (!field.typeName) continue;
      const qualified = qualifyTypeName(field.typeName, name, known);
      if (!qualified) continue;
      field.typeName = qualified;
      const kind = known.get(qualified) as number;
      if (field.type !== TYPE_GROUP && field.type !== kind) field.type = kind;
    }
    repairDescriptor(type.nestedType, name, known);
  }
}

/**
 * Codec from the registry's own compiled descriptors (`?format=serialized`).
 * Message indexes follow the descriptor's message_type / nested_type lists
 * exactly (map-entry types included), as Confluent's deserializers do.
 */
export function buildProtobufCodecFromDescriptors(
  main: FileDescriptorProto,
  references: readonly ProtobufDescriptorReference[] = []
): ProtobufCodec {
  const byName = new Map<string, FileDescriptorProto>();
  for (const ref of references) {
    if (isWellKnown(ref.name) || byName.has(ref.name)) continue;
    // Registries serve descriptors with an empty name; imports use the reference name.
    ref.proto.name = ref.name;
    byName.set(ref.name, ref.proto);
  }
  main.name = MAIN_FILE;
  const resolve = (name: string) => wellKnownFileProto(name) ?? byName.get(name);
  const known = new Map<string, number>();
  const seenFiles = new Set<string>();
  const collect = (file: FileDescriptorProto) => {
    if (seenFiles.has(file.name)) return;
    seenFiles.add(file.name);
    declaredTypes(file, known);
    for (const dep of file.dependency) {
      const resolved = resolve(dep);
      if (resolved) collect(resolved);
    }
  };
  collect(main);
  for (const file of [main, ...byName.values()]) {
    repairDescriptor(file.messageType, file.package ? `.${file.package}` : '', known);
  }
  // Canonical bufbuild descriptors for google/protobuf/* (exact WKT JSON).
  const registry = createFileRegistry(main, resolve);
  return codecFor(registry, false);
}

/**
 * Codec compiled from the schema text (registries that cannot serve
 * descriptors). protobufjs-derived descriptors list map-entry types before
 * explicit nested messages, so explicit messages are counted first — protoc's
 * order whenever nested messages are declared before map fields, which is how
 * registries print normalised schemas.
 */
export function buildProtobufCodec(
  schema: string,
  references: readonly SchemaReference[] = []
): ProtobufCodec {
  const seen = new Set<string>();
  const files = [
    // google/protobuf/* references resolve to bufbuild's canonical descriptors.
    ...references.filter((r) => !isWellKnown(r.name) && !seen.has(r.name) && seen.add(r.name)),
    { name: MAIN_FILE, schema },
  ].map((f) => ({ path: f.name, content: f.schema }));
  const registry = createFileRegistry(
    create(FileDescriptorSetSchema, { file: compileProtoFiles(files) })
  );
  return codecFor(registry, true);
}

function codecFor(registry: FileRegistry, explicitNestedFirst: boolean): ProtobufCodec {
  const file = registry.getFile(MAIN_FILE);
  if (!file) throw new Error('Protobuf schema could not be compiled.');
  if (file.proto.messageType.length === 0) {
    throw new Error('Protobuf schema defines no message types.');
  }

  const prefix = file.proto.package ? `${file.proto.package}.` : '';
  const messageNames: string[] = [];
  const pathByName = new Map<string, number[]>();
  const nameByPath = new Map<string, string>();
  const walk = (types: readonly DescriptorProto[], parent: string, path: number[]) => {
    const ordered = explicitNestedFirst
      ? [...types.filter((t) => !t.options?.mapEntry), ...types.filter((t) => t.options?.mapEntry)]
      : types;
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

  const messageAt = (path: readonly number[]): DescMessage => {
    const name = nameByPath.get(path.join(','));
    const desc = name === undefined ? undefined : registry.getMessage(name);
    if (!desc) throw new Error(`Protobuf message index [${path.join(', ')}] is not in the schema.`);
    return desc;
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
    toJson(desc, fromBinary(desc, bytes), {
      alwaysEmitImplicit: true,
      useProtoFieldName: true,
      registry,
    });

  return {
    messageNames,
    encode(json, messageName) {
      const path = resolvePath(messageName);
      const desc = messageAt(path);
      const payload = resolveLiterals(desc, parseJsonExact(json));
      const unknown = findUnknownJsonFields(desc, payload);
      if (unknown.length > 0) {
        throw new Error(`Unknown field(s) in ${desc.typeName}: ${describeUnknownFields(unknown)}`);
      }
      const value = fromJson(desc, payload as JsonValue, { registry });
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
