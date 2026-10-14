// Unknown-field detection for gRPC request JSON (#925 / #944).
//
// Proto3 JSON parsers SHOULD reject unknown fields; Restura used to ignore
// them, so a typo (`nmae` for `name`) silently sent the default value. This
// walks editor JSON against a method's input descriptor and reports every key
// the schema doesn't know — nested messages, repeated messages, and message
// map values included — with a near-miss suggestion for quick fixes.
//
// Pure (bufbuild descriptors only): runs in the renderer (live lint, pre-send
// gate), the Electron main process, and anywhere else `inputFromJson` runs.
import type { DescMessage } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';

export interface UnknownJsonField {
  /** JSON path of the object holding the key, e.g. `['items', 0]`. */
  parentPath: Array<string | number>;
  /** The unknown key. */
  key: string;
  /** Display path, e.g. `items[0].nmae`. */
  path: string;
  /** Fully-qualified message type the key was checked against. */
  messageType: string;
  /** Closest known field name when the key looks like a typo. */
  suggestion?: string;
}

const MAX_DEPTH = 32;

/** Optimal-string-alignment distance (Levenshtein + adjacent transpositions). */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const row = d[i] as number[];
      const prev = d[i - 1] as number[];
      let best = Math.min(
        (prev[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, ((d[i - 2] as number[])[j - 2] as number) + 1);
      }
      row[j] = best;
    }
  }
  return (d[a.length] as number[])[b.length] as number;
}

/**
 * The closest candidate to `key` (case-insensitive), or undefined when nothing
 * is near enough to be a plausible typo: ≤1 edit for short names, ≤2 otherwise.
 */
export function suggestFieldName(key: string, candidates: Iterable<string>): string | undefined {
  const k = key.toLowerCase();
  let best: { name: string; d: number } | undefined;
  for (const name of candidates) {
    const d = editDistance(k, name.toLowerCase());
    const limit = name.length < 6 ? 1 : 2;
    if (d <= limit && (!best || d < best.d)) best = { name, d };
  }
  return best?.name;
}

// google.protobuf types with a special JSON form (Struct takes arbitrary keys,
// Any carries `@type`, wrappers/Timestamp/… aren't objects) — not checked.
function hasSpecialJson(desc: DescMessage): boolean {
  return desc.typeName.startsWith('google.protobuf.') && desc.typeName !== 'google.protobuf.Empty';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function displayPath(parent: Array<string | number>, key: string): string {
  let out = '';
  for (const seg of parent) out += typeof seg === 'number' ? `[${seg}]` : out ? `.${seg}` : seg;
  return out ? `${out}.${key}` : key;
}

/**
 * Every key in `json` that `desc` (recursively) doesn't define. Accepts both
 * the JSON (lowerCamelCase) and the original proto field name, as the proto3
 * JSON mapping does. Values of the wrong shape are left to the real parser.
 */
export function findUnknownJsonFields(desc: DescMessage, json: unknown): UnknownJsonField[] {
  const out: UnknownJsonField[] = [];
  const walk = (msg: DescMessage, value: unknown, path: Array<string | number>, depth: number) => {
    if (!isPlainObject(value) || hasSpecialJson(msg) || depth > MAX_DEPTH) return;
    const present = new Set(Object.keys(value));
    for (const [key, child] of Object.entries(value)) {
      const field = msg.fields.find((f) => f.jsonName === key || f.name === key);
      if (!field) {
        const candidates = msg.fields
          .flatMap((f) => [f.jsonName, f.name])
          .filter((n) => !present.has(n));
        const suggestion = suggestFieldName(key, new Set(candidates));
        out.push({
          parentPath: path,
          key,
          path: displayPath(path, key),
          messageType: msg.typeName,
          ...(suggestion ? { suggestion } : {}),
        });
        continue;
      }
      if (child === null) continue;
      const here = [...path, key];
      if (field.fieldKind === 'message') {
        walk(field.message, child, here, depth + 1);
      } else if (
        field.fieldKind === 'list' &&
        field.listKind === 'message' &&
        Array.isArray(child)
      ) {
        child.forEach((item, i) => walk(field.message, item, [...here, i], depth + 1));
      } else if (field.fieldKind === 'map' && field.mapKind === 'message' && isPlainObject(child)) {
        for (const [mk, mv] of Object.entries(child))
          walk(field.message, mv, [...here, mk], depth + 1);
      }
    }
  };
  walk(desc, json, [], 0);
  return out;
}

/** `nmae (did you mean "name"?), items[0].qyt` — for error / warning text. */
export function describeUnknownFields(fields: readonly UnknownJsonField[]): string {
  return fields
    .map((f) => (f.suggestion ? `${f.path} (did you mean "${f.suggestion}"?)` : f.path))
    .join(', ');
}

/**
 * Thrown by `inputFromJson` in strict mode. A `ConnectError` with
 * INVALID_ARGUMENT so every transport reports it as a gRPC status (3) rather
 * than an opaque UNKNOWN.
 */
export class GrpcUnknownFieldsError extends ConnectError {
  constructor(
    public readonly fields: UnknownJsonField[],
    messageType: string
  ) {
    super(
      `Unknown field(s) in ${messageType} request message: ${describeUnknownFields(fields)}. ` +
        'Fix or remove them; unknown fields are rejected rather than silently dropped.',
      Code.InvalidArgument
    );
    // `name` stays "ConnectError" so `instanceof ConnectError` / ConnectError.from
    // keep working; this subclass check uses the ordinary prototype chain
    // (ConnectError's own [Symbol.hasInstance] is duck-typed).
  }

  static override [Symbol.hasInstance](v: unknown): boolean {
    return Function.prototype[Symbol.hasInstance].call(GrpcUnknownFieldsError, v);
  }
}
