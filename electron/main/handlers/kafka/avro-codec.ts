// Avro JSON mapping for the Schema Registry path (encode coercion, decode
// normalisation, 64-bit longs). Avro itself is parsed/serialised by the avsc
// build that @kafkajs/confluent-schema-registry ships (its `avsc` range pins the
// version; `avsc` is deliberately resolved through that package so the Type
// instances this module creates are the ones the library's types accept — see
// kafka-schema-codecs.test.ts for the API this relies on).
//
// - bytes / fixed (incl. decimal) are strings of code points 0-255 in both
//   directions (Avro JSON encoding), so a consumed record re-produces as-is.
// - long uses the full 64-bit range: safe integers stay numbers, anything
//   larger is a decimal string. Exception: a union that mixes long with
//   another number or string branch keeps avsc's native long, because an
//   abstract long there makes avsc reject every value as ambiguous.
// - unions accept the avsc form (unwrapped when unambiguous) and the Avro JSON
//   wrapped form ({"string": "x"}, {"ns.Record": {…}}, or the short name). A
//   single-key object naming a branch is read as the wrapped form first; a bare
//   value goes to the branch that fits it without conversion, then the one
//   with the fewest unknown record keys.

import { createRequire } from 'node:module';
import { type AvscTypeLike, BigIntLiteral } from './schema-types';

type AvscModule = {
  types: { LongType: { __with(methods: Record<string, unknown>): unknown } };
  Type: { forSchema(schema: unknown, opts?: Record<string, unknown>): unknown };
};

let _avsc: AvscModule | undefined;
function avsc(): AvscModule {
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

/** Marks a union's long branch that must stay avsc's native long (see below). */
const NATIVE_LONG = 'x-restura-native-long';
/** Branch types a JSON number or string could also be read as. */
const LONG_CONFLICTS = new Set(['int', 'float', 'double', 'string', 'enum', 'bytes', 'fixed']);

function primitiveOf(branch: unknown): string | undefined {
  if (typeof branch === 'string') return branch;
  if (branch && typeof branch === 'object' && !Array.isArray(branch)) {
    const type = (branch as { type?: unknown }).type;
    return typeof type === 'string' ? type : undefined;
  }
  return undefined;
}

function isLongSchema(schema: unknown): boolean {
  return primitiveOf(schema) === 'long';
}

/**
 * avsc typeHook: every `long` (incl. logical types over long) uses
 * {@link int64LongType}, except inside a union that mixes long with another
 * number/string branch — there the abstract type would make avsc throw
 * "ambiguous conversion" for every value, so that union is rebuilt with a
 * native long branch (values beyond 2^53 cannot be told apart from doubles in
 * JSON anyway).
 */
export function avroTypeHook(schema: unknown, opts?: Record<string, unknown>): unknown {
  if (Array.isArray(schema)) {
    if (schema.some((b) => b && typeof b === 'object' && NATIVE_LONG in (b as object))) {
      return undefined;
    }
    const hasLong = schema.some(isLongSchema);
    const conflicts = schema.some(
      (b) => !isLongSchema(b) && LONG_CONFLICTS.has(primitiveOf(b) ?? '')
    );
    if (hasLong && conflicts) {
      const marked = schema.map((b) =>
        isLongSchema(b)
          ? { ...(typeof b === 'string' ? { type: b } : (b as object)), [NATIVE_LONG]: true }
          : b
      );
      return avsc().Type.forSchema(marked, opts);
    }
    return undefined;
  }
  if (schema && typeof schema === 'object' && NATIVE_LONG in (schema as object)) return undefined;
  return isLongSchema(schema) ? int64LongType() : undefined;
}

function isAvscType(value: unknown): value is AvscTypeLike {
  return !!value && typeof (value as { typeName?: unknown }).typeName === 'string';
}

function branchNameOf(type: AvscTypeLike): string {
  return type.branchName ?? type.name ?? type.typeName;
}

function baseTypeName(type: AvscTypeLike): string {
  return type.typeName.startsWith('logical:') && type.underlyingType
    ? baseTypeName(type.underlyingType)
    : type.typeName;
}

/** 0 when the value fits the branch as-is, 1 when it needs a JSON-convention conversion. */
function conversionCost(branch: AvscTypeLike, value: unknown): number {
  if (typeof value !== 'string') return 0;
  const base = baseTypeName(branch);
  return base === 'bytes' || base === 'fixed' || base === 'long' || base.startsWith('abstract')
    ? 1
    : 0;
}

/** Keys of a record value that the record branch does not declare. */
function unknownKeys(branch: AvscTypeLike, value: unknown): number {
  if (baseTypeName(branch) !== 'record' || !value || typeof value !== 'object') return 0;
  const names = new Set((branch.fields ?? []).map((f) => f.name));
  return Object.keys(value).filter((k) => !names.has(k)).length;
}

function coerceUnion(type: AvscTypeLike, value: unknown, depth: number): unknown {
  const branches = type.types ?? [];
  const wrapped = type.typeName === 'union:wrapped';
  const wrap = (branch: AvscTypeLike, inner: unknown): unknown =>
    wrapped && inner !== null ? { [branchNameOf(branch)]: inner } : inner;

  // 1. Avro JSON wrapped form {"<branch name>": value} (full or short name).
  if (value && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value)) {
    const keys = Object.keys(value);
    const key = keys.length === 1 ? (keys[0] as string) : undefined;
    const branch =
      key === undefined
        ? undefined
        : (branches.find((b) => branchNameOf(b) === key) ??
          branches.find((b) => branchNameOf(b).endsWith(`.${key}`)));
    if (branch && key !== undefined) {
      const coerced = coerceAvroValue(branch, (value as Record<string, unknown>)[key], depth + 1);
      if (branch.isValid(coerced)) return wrap(branch, coerced);
    }
  }

  // 2. Bare value: the best-fitting valid branch.
  let best: { branch: AvscTypeLike; coerced: unknown; score: number } | undefined;
  for (const branch of branches) {
    const coerced = coerceAvroValue(branch, value, depth + 1);
    if (!branch.isValid(coerced)) continue;
    const score = conversionCost(branch, value) * 1_000 + unknownKeys(branch, value);
    if (!best || score < best.score) best = { branch, coerced, score };
    if (score === 0) break;
  }
  return best ? wrap(best.branch, best.coerced) : value;
}

function coerceAvroValue(type: AvscTypeLike, value: unknown, depth: number): unknown {
  if (depth > 64) return value;
  const name = type.typeName;
  if (name === 'bytes' || name === 'fixed') {
    // Avro JSON encoding: bytes/fixed are strings of code points 0-255.
    return typeof value === 'string' ? Buffer.from(value, 'latin1') : value;
  }
  if (value instanceof BigIntLiteral) {
    // An integer literal beyond 2^53: exact text for longs, a number otherwise.
    const base = baseTypeName(type);
    return base === 'long' || base.startsWith('abstract') ? value.source : value.toNumber();
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
 * Convert the Avro JSON conventions (code-point strings, wrapped unions, exact
 * large integers as text) into the values avsc expects before encoding.
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
