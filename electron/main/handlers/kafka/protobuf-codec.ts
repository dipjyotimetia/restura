// Confluent Schema Registry Protobuf codec (wire format + JSON mapping).
//
// Replaces the @kafkajs/confluent-schema-registry Protobuf path, which does not
// implement the Confluent framing: it writes no message-index array after the
// schema id (so Confluent Java/Go/Python/.NET deserializers cannot read what we
// produce), ignores the index array on decode (always the first message), picks
// the "first" type by object-key order (a registry that normalises enums first
// makes every such schema fail with "no such type"), and cannot resolve
// google/protobuf/* imports.
//
// Wire body after magic byte + schema id (https://docs.confluent.io/platform/current/schema-registry/fundamentals/serdes-develop/index.html#wire-format):
//   message-indexes: zigzag varint count, then that many zigzag varint indexes
//                    (the path to the message type, top-level index first);
//                    the common [0] path is written as a single 0x00 byte.
//   protobuf payload.
//
// JSON mapping: field names are the .proto names (keepCase); the lowerCamelCase
// JSON names are also accepted on input. 64-bit integers decode as decimal
// strings, enums as names, bytes as Base64 — all accepted back on encode, so a
// consumed record can be edited and re-produced.

import * as protobuf from 'protobufjs';

export interface ProtobufReference {
  name: string;
  schema: string;
}

export interface ProtobufCodec {
  /** Fully-qualified names (no leading dot) of the file's messages, in index order. */
  readonly messageNames: readonly string[];
  /** Encode a JSON-shaped value; returns message-indexes + payload (no magic/id). */
  encode(payload: unknown, messageName?: string): Buffer;
  /** Decode message-indexes + payload (no magic/id) to a JSON-safe value. */
  decode(body: Buffer): unknown;
}

const MAX_INDEX_DEPTH = 32;
const MAX_VALIDATION_DEPTH = 64;
const PARSE_OPTIONS = { keepCase: true, alternateCommentMode: false } as const;
const TO_OBJECT_OPTIONS: protobuf.IConversionOptions = {
  longs: String,
  enums: String,
  bytes: String,
  defaults: true,
  arrays: true,
  objects: true,
};

// --- message-index varints -------------------------------------------------

function writeZigZagVarint(value: number, out: number[]): void {
  let n = (value << 1) ^ (value >> 31);
  n >>>= 0;
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
}

export function encodeMessageIndexes(path: readonly number[]): Buffer {
  if (path.length === 1 && path[0] === 0) return Buffer.from([0]);
  const out: number[] = [];
  writeZigZagVarint(path.length, out);
  for (const index of path) writeZigZagVarint(index, out);
  return Buffer.from(out);
}

function readZigZagVarint(buf: Buffer, offset: number): { value: number; offset: number } {
  let result = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) throw new Error('Truncated Protobuf message-index varint.');
    const byte = buf[pos++] as number;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 28) throw new Error('Protobuf message-index varint is too long.');
  }
  return { value: (result >>> 1) ^ -(result & 1), offset: pos };
}

export function decodeMessageIndexes(body: Buffer): { path: number[]; offset: number } {
  const count = readZigZagVarint(body, 0);
  if (count.value === 0) return { path: [0], offset: count.offset };
  if (count.value < 0 || count.value > MAX_INDEX_DEPTH) {
    throw new Error(`Invalid Protobuf message-index count ${count.value}.`);
  }
  const path: number[] = [];
  let offset = count.offset;
  for (let i = 0; i < count.value; i++) {
    const next = readZigZagVarint(body, offset);
    if (next.value < 0) throw new Error('Invalid negative Protobuf message index.');
    path.push(next.value);
    offset = next.offset;
  }
  return { path, offset };
}

// --- schema loading --------------------------------------------------------

function nestedTypes(ns: protobuf.NamespaceBase): protobuf.Type[] {
  return ns.nestedArray.filter((n): n is protobuf.Type => n instanceof protobuf.Type);
}

function addWellKnownImport(root: protobuf.Root, file: string): boolean {
  const descriptor = protobuf.common.get(file);
  if (!descriptor?.nested) return false;
  root.addJSON(descriptor.nested);
  return true;
}

/**
 * Build the codec for a registry Protobuf schema plus its (already resolved,
 * dependency-first) references. Throws when the schema does not parse or a type
 * cannot be resolved.
 */
export function buildProtobufCodec(
  schema: string,
  references: readonly ProtobufReference[] = []
): ProtobufCodec {
  const root = new protobuf.Root();
  const provided = new Set<string>();
  for (const ref of references) {
    if (provided.has(ref.name)) continue;
    provided.add(ref.name);
    protobuf.parse(ref.schema, root, PARSE_OPTIONS);
  }
  const parsed = protobuf.parse(schema, root, PARSE_OPTIONS);
  // Registries treat google/protobuf/* as built in; resolve them unless a
  // reference already supplied the file. Imports of reference files may also
  // name WKTs, so scan the references' imports too.
  const imports = new Set<string>(parsed.imports ?? []);
  for (const ref of references) {
    for (const imp of protobuf.parse(ref.schema, new protobuf.Root(), PARSE_OPTIONS).imports ??
      []) {
      imports.add(imp);
    }
  }
  for (const file of imports) {
    if (!provided.has(file) && file.startsWith('google/protobuf/')) {
      addWellKnownImport(root, file);
      provided.add(file);
    }
  }
  root.resolveAll();

  // Message indexes count only this file's messages, in declaration order, so
  // read the order from the main schema parsed on its own.
  const alone = protobuf.parse(schema, new protobuf.Root(), PARSE_OPTIONS);
  const pkg = alone.package ?? '';
  const ownNs = pkg ? alone.root.lookup(pkg) : alone.root;
  if (!(ownNs instanceof protobuf.Namespace) && !(ownNs instanceof protobuf.Root)) {
    throw new Error('Protobuf schema package could not be resolved.');
  }
  const prefix = pkg ? `${pkg}.` : '';
  const topLevel = nestedTypes(ownNs as protobuf.NamespaceBase).map((t) =>
    root.lookupType(`${prefix}${t.name}`)
  );
  if (topLevel.length === 0) throw new Error('Protobuf schema defines no message types.');

  const messageNames: string[] = [];
  const pathByName = new Map<string, number[]>();
  const walk = (types: protobuf.Type[], path: number[]) => {
    types.forEach((type, index) => {
      const nextPath = [...path, index];
      const fullName = type.fullName.replace(/^\./, '');
      messageNames.push(fullName);
      pathByName.set(fullName, nextPath);
      if (nextPath.length < MAX_INDEX_DEPTH) walk(nestedTypes(type), nextPath);
    });
  };
  walk(topLevel, []);

  const typeAt = (path: readonly number[]): protobuf.Type => {
    let types = topLevel;
    let type: protobuf.Type | undefined;
    for (const index of path) {
      type = types[index];
      if (!type)
        throw new Error(`Protobuf message index [${path.join(', ')}] is not in the schema.`);
      types = nestedTypes(type);
    }
    if (!type) throw new Error('Empty Protobuf message-index path.');
    return type;
  };

  const resolvePath = (messageName: string | undefined): number[] => {
    if (!messageName) return [0];
    const bare = messageName.replace(/^\./, '');
    const exact = pathByName.get(bare) ?? pathByName.get(`${prefix}${bare}`);
    if (exact) return exact;
    throw new Error(
      `Protobuf message "${messageName}" is not defined in the schema (${messageNames.join(', ')}).`
    );
  };

  return {
    messageNames,
    encode(payload, messageName) {
      const path = resolvePath(messageName);
      const type = typeAt(path);
      const errors: string[] = [];
      const normalized = normalizeMessage(type, payload, '', errors, 0);
      if (errors.length > 0) {
        throw new Error(`Invalid ${type.name} payload: ${errors.slice(0, 10).join('; ')}`);
      }
      const message = type.fromObject(normalized as Record<string, unknown>);
      return Buffer.concat([
        encodeMessageIndexes(path),
        Buffer.from(type.encode(message).finish()),
      ]);
    },
    decode(body) {
      try {
        const { path, offset } = decodeMessageIndexes(body);
        const type = typeAt(path);
        return type.toObject(type.decode(body.subarray(offset)), TO_OBJECT_OPTIONS);
      } catch (strictError) {
        // Legacy frames with no message-index array (KafkaJS'
        // @kafkajs/confluent-schema-registry, and Restura before this codec)
        // carry the first message type's payload right after the schema id.
        const first = topLevel[0] as protobuf.Type;
        try {
          return first.toObject(first.decode(body), TO_OBJECT_OPTIONS);
        } catch {
          throw strictError;
        }
      }
    },
  };
}

// --- JSON value validation / normalisation --------------------------------

const INT_RE = /^-?\d+$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/_-]{4})*(?:[A-Za-z0-9+/_-]{2}(?:==)?|[A-Za-z0-9+/_-]{3}=?)?$/;
const RANGES: Record<string, [bigint, bigint]> = {
  int32: [-(2n ** 31n), 2n ** 31n - 1n],
  sint32: [-(2n ** 31n), 2n ** 31n - 1n],
  sfixed32: [-(2n ** 31n), 2n ** 31n - 1n],
  uint32: [0n, 2n ** 32n - 1n],
  fixed32: [0n, 2n ** 32n - 1n],
  int64: [-(2n ** 63n), 2n ** 63n - 1n],
  sint64: [-(2n ** 63n), 2n ** 63n - 1n],
  sfixed64: [-(2n ** 63n), 2n ** 63n - 1n],
  uint64: [0n, 2n ** 64n - 1n],
  fixed64: [0n, 2n ** 64n - 1n],
};

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function normalizeInteger(scalar: string, value: unknown, path: string, errors: string[]): unknown {
  const range = RANGES[scalar] as [bigint, bigint];
  let big: bigint;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      errors.push(`${path}: ${scalar} expected an integer, got ${value}`);
      return value;
    }
    if (!Number.isSafeInteger(value)) {
      errors.push(`${path}: ${value} exceeds JSON number precision; pass ${scalar} as a string`);
      return value;
    }
    big = BigInt(value);
  } else if (typeof value === 'string' && INT_RE.test(value.trim())) {
    big = BigInt(value.trim());
  } else {
    errors.push(`${path}: ${scalar} expected an integer, got ${describe(value)}`);
    return value;
  }
  if (big < range[0] || big > range[1]) {
    errors.push(`${path}: ${big} is out of range for ${scalar}`);
    return value;
  }
  // protobufjs takes 64-bit values as decimal strings; 32-bit as numbers.
  return range[1] > 2n ** 32n ? big.toString() : Number(big);
}

function normalizeScalar(scalar: string, value: unknown, path: string, errors: string[]): unknown {
  switch (scalar) {
    case 'double':
    case 'float':
      if (typeof value === 'number') return value;
      if (value === 'NaN' || value === 'Infinity' || value === '-Infinity') return Number(value);
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
        return Number(value);
      errors.push(`${path}: ${scalar} expected a number, got ${describe(value)}`);
      return value;
    case 'bool':
      if (typeof value === 'boolean') return value;
      errors.push(`${path}: bool expected true/false, got ${describe(value)}`);
      return value;
    case 'string':
      if (typeof value === 'string') return value;
      errors.push(`${path}: string expected, got ${describe(value)}`);
      return value;
    case 'bytes':
      if (typeof value === 'string' && BASE64_RE.test(value)) {
        return value.replace(/-/g, '+').replace(/_/g, '/');
      }
      errors.push(`${path}: bytes expected a Base64 string`);
      return value;
    default:
      if (scalar in RANGES) return normalizeInteger(scalar, value, path, errors);
      errors.push(`${path}: unsupported scalar type ${scalar}`);
      return value;
  }
}

function normalizeEnum(
  enumType: protobuf.Enum,
  value: unknown,
  path: string,
  errors: string[]
): unknown {
  if (typeof value === 'string') {
    if (value in enumType.values) return value;
    errors.push(
      `${path}: "${value}" is not a ${enumType.name} value (${Object.keys(enumType.values).join(', ')})`
    );
    return value;
  }
  if (typeof value === 'number' && Number.isInteger(value) && Math.abs(value) < 2 ** 31) {
    return value;
  }
  errors.push(`${path}: ${enumType.name} expected a name or integer, got ${describe(value)}`);
  return value;
}

function normalizeSingle(
  field: protobuf.Field,
  value: unknown,
  path: string,
  errors: string[],
  depth: number
): unknown {
  const resolved = field.resolvedType;
  if (resolved instanceof protobuf.Enum) return normalizeEnum(resolved, value, path, errors);
  if (resolved instanceof protobuf.Type)
    return normalizeMessage(resolved, value, path, errors, depth);
  return normalizeScalar(field.type, value, path, errors);
}

function normalizeMapKey(keyType: string, key: string, path: string, errors: string[]): string {
  if (keyType === 'string') return key;
  if (keyType === 'bool') {
    if (key !== 'true' && key !== 'false') errors.push(`${path}: bool map key must be true/false`);
    return key;
  }
  normalizeInteger(keyType, key, path, errors);
  return key;
}

function normalizeMessage(
  type: protobuf.Type,
  value: unknown,
  path: string,
  errors: string[],
  depth: number
): unknown {
  if (depth > MAX_VALIDATION_DEPTH) {
    errors.push(`${path || type.name}: nesting is too deep`);
    return value;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${path || type.name}: ${type.name} expected an object, got ${describe(value)}`);
    return value;
  }
  const byJsonName = new Map<string, protobuf.Field>();
  for (const field of type.fieldsArray) {
    byJsonName.set(field.name, field);
    const camel = field.name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
    if (!byJsonName.has(camel)) byJsonName.set(camel, field);
  }
  const out: Record<string, unknown> = {};
  const oneofSet = new Map<string, string>();
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const field = byJsonName.get(key);
    const fieldPath = path ? `${path}.${key}` : key;
    if (!field) {
      errors.push(`${fieldPath}: unknown field for ${type.name}`);
      continue;
    }
    // proto3 JSON: null means "unset" for every field kind.
    if (raw === null || raw === undefined) continue;
    if (field.partOf) {
      const previous = oneofSet.get(field.partOf.name);
      if (previous) {
        errors.push(`${fieldPath}: oneof ${field.partOf.name} already set by ${previous}`);
        continue;
      }
      oneofSet.set(field.partOf.name, key);
    }
    if (field instanceof protobuf.MapField) {
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        errors.push(`${fieldPath}: map expected an object, got ${describe(raw)}`);
        continue;
      }
      const entries: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        const entryPath = `${fieldPath}[${JSON.stringify(k)}]`;
        entries[normalizeMapKey(field.keyType, k, entryPath, errors)] = normalizeSingle(
          field,
          v,
          entryPath,
          errors,
          depth + 1
        );
      }
      out[field.name] = entries;
    } else if (field.repeated) {
      if (!Array.isArray(raw)) {
        errors.push(`${fieldPath}: repeated field expected an array, got ${describe(raw)}`);
        continue;
      }
      out[field.name] = raw.map((item, i) =>
        normalizeSingle(field, item, `${fieldPath}[${i}]`, errors, depth + 1)
      );
    } else {
      out[field.name] = normalizeSingle(field, raw, fieldPath, errors, depth + 1);
    }
  }
  return out;
}
