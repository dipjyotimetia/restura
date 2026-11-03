// Avro JSON mapping for the Schema Registry path (encode coercion, decode
// normalisation, 64-bit longs). Avro itself is still parsed/serialised by the
// avsc build that @kafkajs/confluent-schema-registry ships, so the types this
// module hands it (the long type below) come from that same avsc instance.
//
// - bytes / fixed (incl. decimal) are strings of code points 0-255 in both
//   directions (Avro JSON encoding), so a consumed record re-produces as-is.
//   Decoded Buffers used to reach the UI as {"type":"Buffer","data":[…]}.
// - long uses the full 64-bit range: safe integers stay numbers, anything
//   larger is a decimal string. avsc's default refuses unsafe longs, so
//   records with e.g. Snowflake ids or nanosecond timestamps failed to decode.
// - unions accept both the avsc form (unwrapped when unambiguous) and the
//   Avro JSON wrapped form ({"string": "x"}, {"ns.Record": {…}}).

import { createRequire } from 'node:module';

interface AvscTypeLike {
  typeName: string;
  branchName?: string;
  name?: string;
  fields?: { name: string; type: AvscTypeLike }[];
  itemsType?: AvscTypeLike;
  valuesType?: AvscTypeLike;
  types?: AvscTypeLike[];
  underlyingType?: AvscTypeLike;
  isValid?: (value: unknown) => boolean;
}

type AvscModule = {
  types: { LongType: { __with(methods: Record<string, unknown>): unknown } };
};

let _avsc: AvscModule | undefined;
function avsc(): AvscModule {
  // Resolve avsc from the registry library so Type instances are compatible.
  _avsc ??= createRequire(require.resolve('@kafkajs/confluent-schema-registry'))(
    'avsc'
  ) as AvscModule;
  return _avsc;
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const INT_RE = /^-?\d+$/;

function toBigInt(value: unknown): bigint | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : undefined;
  if (typeof value === 'string' && INT_RE.test(value)) return BigInt(value);
  if (typeof value === 'bigint') return value;
  return undefined;
}

function isInt64(value: unknown): boolean {
  const big = toBigInt(value);
  return big !== undefined && big >= INT64_MIN && big <= INT64_MAX;
}

function fromInt64(big: bigint): number | string {
  return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(big)
    : big.toString();
}

let _longType: unknown;
/** avsc long type covering the full int64 range (number when safe, else decimal string). */
export function int64LongType(): unknown {
  _longType ??= avsc().types.LongType.__with({
    fromBuffer: (buf: Buffer) => fromInt64(buf.readBigInt64LE(0)),
    toBuffer: (value: unknown) => {
      const buf = Buffer.alloc(8);
      buf.writeBigInt64LE(toBigInt(value) as bigint);
      return buf;
    },
    fromJSON: (value: unknown) => {
      const big = toBigInt(value);
      return big === undefined ? value : fromInt64(big);
    },
    toJSON: (value: unknown) => value,
    isValid: isInt64,
    compare: (a: unknown, b: unknown) => {
      const x = toBigInt(a) as bigint;
      const y = toBigInt(b) as bigint;
      return x < y ? -1 : x > y ? 1 : 0;
    },
  });
  return _longType;
}

/** avsc typeHook: every `long` (incl. logical types over long) uses {@link int64LongType}. */
export function avroTypeHook(schema: unknown): unknown {
  if (schema === 'long') return int64LongType();
  if (schema && typeof schema === 'object' && (schema as { type?: unknown }).type === 'long') {
    return int64LongType();
  }
  return undefined;
}

function isAvscType(value: unknown): value is AvscTypeLike {
  return !!value && typeof (value as { typeName?: unknown }).typeName === 'string';
}

function branchNameOf(type: AvscTypeLike): string | undefined {
  return type.branchName ?? type.name ?? type.typeName;
}

function coerceUnion(type: AvscTypeLike, value: unknown, depth: number): unknown {
  const branches = type.types ?? [];
  const wrapped = type.typeName === 'union:wrapped';
  const wrap = (branch: AvscTypeLike, inner: unknown): unknown =>
    wrapped && inner !== null ? { [branchNameOf(branch) as string]: inner } : inner;
  // 1. The avsc / unwrapped form: first branch the (coerced) value is valid for.
  for (const branch of branches) {
    const coerced = coerceAvroValue(branch, value, depth + 1);
    if (branch.isValid?.(coerced)) return wrap(branch, coerced);
  }
  // 2. The Avro JSON wrapped form {"<branch name>": value}.
  if (value && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1) {
      const key = keys[0] as string;
      const branch = branches.find(
        (b) =>
          branchNameOf(b) === key ||
          // Allow the short name of a namespaced branch ({"Card": …} for ns.Card).
          (branchNameOf(b) ?? '').endsWith(`.${key}`)
      );
      if (branch) {
        const coerced = coerceAvroValue(branch, (value as Record<string, unknown>)[key], depth + 1);
        if (branch.isValid?.(coerced)) return wrap(branch, coerced);
      }
    }
  }
  return value;
}

function coerceAvroValue(type: AvscTypeLike, value: unknown, depth: number): unknown {
  if (depth > 64) return value;
  const name = type.typeName;
  if (name === 'bytes' || name === 'fixed') {
    // Avro JSON encoding: bytes/fixed are strings of code points 0-255.
    return typeof value === 'string' ? Buffer.from(value, 'latin1') : value;
  }
  if ((name === 'record' || name === 'error') && value && typeof value === 'object') {
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const field of type.fields ?? []) {
      if (field.name in out)
        out[field.name] = coerceAvroValue(field.type, out[field.name], depth + 1);
    }
    return out;
  }
  if (name === 'array' && Array.isArray(value) && type.itemsType) {
    const items = type.itemsType;
    return value.map((item) => coerceAvroValue(items, item, depth + 1));
  }
  if (name === 'map' && value && typeof value === 'object' && type.valuesType) {
    const values = type.valuesType;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        coerceAvroValue(values, v, depth + 1),
      ])
    );
  }
  if (name.startsWith('union') && type.types) return coerceUnion(type, value, depth);
  if (name.startsWith('logical:') && type.underlyingType) {
    return coerceAvroValue(type.underlyingType, value, depth + 1);
  }
  return value;
}

/**
 * JSON payloads cannot carry Buffers or wrapped-union ambiguity, so convert the
 * Avro JSON conventions into the values avsc expects before encoding.
 * Non-Avro schemas pass through.
 */
export function coerceAvroPayload(schema: unknown, payload: unknown): unknown {
  return isAvscType(schema) ? coerceAvroValue(schema, payload, 0) : payload;
}

/**
 * Turn an avsc-decoded value into plain JSON-safe data: Buffers become
 * code-point-0-255 strings (symmetric with {@link coerceAvroPayload}), record
 * class instances become plain objects.
 */
export function normalizeAvroDecoded(value: unknown, depth = 0): unknown {
  if (depth > 128 || value === null || typeof value !== 'object') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('latin1');
  if (Array.isArray(value)) return value.map((v) => normalizeAvroDecoded(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = normalizeAvroDecoded(v, depth + 1);
  }
  return out;
}
