// Shapes shared by the Schema Registry codecs (avro-codec.ts, protobuf-codec.ts,
// json-schema-codec.ts, schema-codecs.ts).

/** A resolved registry reference: its import name and schema text. */
export interface SchemaReference {
  name: string;
  schema: string;
}

/** Structural slice of an avsc Type (the registry library's avsc build). */
export interface AvscTypeLike {
  typeName: string;
  branchName?: string;
  name?: string;
  fields?: { name: string; type: AvscTypeLike }[];
  itemsType?: AvscTypeLike;
  valuesType?: AvscTypeLike;
  types?: AvscTypeLike[];
  underlyingType?: AvscTypeLike;
  isValid(value: unknown, opts?: { errorHook?: (path: string[]) => void }): boolean;
  toBuffer(value: unknown): Buffer;
  fromBuffer(buf: Buffer): unknown;
}

/** An integer literal beyond 2^53, kept as its exact decimal text. */
export class BigIntLiteral {
  readonly source: string;

  constructor(source: string) {
    this.source = source;
  }
  /** The value for a non-integer (double) target. */
  toNumber(): number {
    return Number(this.source);
  }
}

/**
 * `JSON.parse` that keeps integer literals beyond 2^53 exactly (a plain parse
 * rounds them) as {@link BigIntLiteral}s. Each codec then resolves a literal by
 * its target type: 64-bit integers take the exact text, doubles the number.
 */
export function parseJsonExact(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) =>
    typeof value === 'number' &&
    !Number.isSafeInteger(value) &&
    typeof context?.source === 'string' &&
    /^-?\d+$/.test(context.source)
      ? new BigIntLiteral(context.source)
      : value
  );
}
