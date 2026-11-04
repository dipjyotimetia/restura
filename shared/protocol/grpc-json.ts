import { type DescField, type DescMessage, ScalarType } from '@bufbuild/protobuf';

/**
 * Parse a gRPC request message typed as JSON without losing 64-bit integer
 * precision.
 *
 * `JSON.parse` turns every number into an IEEE double, so an int64/uint64
 * written as a bare JSON number past `Number.MAX_SAFE_INTEGER` (e.g.
 * `9007199254740993`) is silently rounded before protobuf ever sees it. The
 * proto3 JSON mapping accepts 64-bit integers as decimal strings, so integer
 * literals outside the safe range are quoted before parsing — the protobuf JSON
 * decoder then reads the exact digits. Safe integers, fractions, exponents and
 * string contents are left untouched.
 *
 * Quoting is only right for 64-bit integer positions, though: inside a
 * `google.protobuf.Struct` / `Value` / `ListValue` (or a double/float field) a
 * quoted literal would turn a `number_value` into a `string_value`. When the
 * method's input schema is known, pass it as `inputSchema` (or a lazy getter —
 * it is only consulted when the text actually holds an unsafe integer): every
 * unsafe literal that does NOT sit in a 64-bit integer position then stays a
 * JSON number (the double semantics those positions have anyway). Without a
 * schema every unsafe literal stays quoted (int64 is the common case).
 *
 * Shared by the renderer (Electron IPC / Worker proxy / gRPC-Web paths) and the
 * CLI so every harness sends the same value. Throws `SyntaxError` on invalid
 * JSON, exactly like `JSON.parse`.
 */
export function parseGrpcMessageJson(
  text: string,
  inputSchema?: DescMessage | (() => DescMessage | undefined)
): unknown {
  const quotedText = quoteUnsafeIntegers(text);
  const quoted: unknown = JSON.parse(quotedText);
  if (quotedText === text || inputSchema === undefined) return quoted;
  const schema = typeof inputSchema === 'function' ? inputSchema() : inputSchema;
  if (!schema) return quoted;
  const raw: unknown = JSON.parse(text);
  // A top-level array is a list of messages (client / bidi stream body).
  if (Array.isArray(quoted) && Array.isArray(raw)) {
    return quoted.map((q, i) => mergeMessage(q, raw[i], schema));
  }
  return mergeMessage(quoted, raw, schema);
}

const INT64_SCALARS = new Set<ScalarType>([
  ScalarType.INT64,
  ScalarType.UINT64,
  ScalarType.SINT64,
  ScalarType.FIXED64,
  ScalarType.SFIXED64,
]);

/** Well-known types whose JSON numbers are doubles: never quote inside them. */
const DOUBLE_JSON_WKT = new Set([
  'google.protobuf.Struct',
  'google.protobuf.Value',
  'google.protobuf.ListValue',
  'google.protobuf.DoubleValue',
  'google.protobuf.FloatValue',
]);
/** Wrapper well-known types whose JSON form is a bare 64-bit integer. */
const INT64_WRAPPER_WKT = new Set(['google.protobuf.Int64Value', 'google.protobuf.UInt64Value']);

/**
 * Walk the quoted parse (`q`) and the plain parse (`r`) of the same text in
 * step with the schema. A position where `q` holds a string but `r` a number
 * is a literal we quoted: it stays quoted only in an int64 position. Anything
 * the schema can't place (unknown keys, `Any`) keeps the quoted value — the
 * schema-less default.
 */
function mergeMessage(q: unknown, r: unknown, desc: DescMessage): unknown {
  if (DOUBLE_JSON_WKT.has(desc.typeName)) return r;
  if (INT64_WRAPPER_WKT.has(desc.typeName)) return q;
  if (!isPlainObject(q) || !isPlainObject(r)) return q;
  const out: Record<string, unknown> = {};
  for (const [key, qv] of Object.entries(q)) {
    const field = desc.fields.find((f) => f.jsonName === key || f.name === key);
    out[key] = field ? mergeField(qv, r[key], field) : qv;
  }
  return out;
}

function mergeField(q: unknown, r: unknown, field: DescField): unknown {
  switch (field.fieldKind) {
    case 'scalar':
      return mergeScalar(q, r, field.scalar);
    case 'message':
      return mergeMessage(q, r, field.message);
    case 'list': {
      if (!Array.isArray(q) || !Array.isArray(r)) return q;
      if (field.listKind === 'message') {
        const desc = field.message;
        return q.map((qv, i) => mergeMessage(qv, r[i], desc));
      }
      if (field.listKind === 'scalar') {
        const scalar = field.scalar;
        return q.map((qv, i) => mergeScalar(qv, r[i], scalar));
      }
      return q.map((qv, i) => unquote(qv, r[i]));
    }
    case 'map': {
      if (!isPlainObject(q) || !isPlainObject(r)) return q;
      const out: Record<string, unknown> = {};
      for (const [k, qv] of Object.entries(q)) {
        if (field.mapKind === 'message') out[k] = mergeMessage(qv, r[k], field.message);
        else if (field.mapKind === 'scalar') out[k] = mergeScalar(qv, r[k], field.scalar);
        else out[k] = unquote(qv, r[k]);
      }
      return out;
    }
    default:
      // enum: an unsafe enum number is invalid either way; send what was typed.
      return unquote(q, r);
  }
}

function mergeScalar(q: unknown, r: unknown, scalar: ScalarType): unknown {
  return INT64_SCALARS.has(scalar) ? q : unquote(q, r);
}

/** Undo quoteUnsafeIntegers at a position that is not a 64-bit integer. */
function unquote(q: unknown, r: unknown): unknown {
  return typeof q === 'string' && typeof r === 'number' ? r : q;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const INTEGER_LITERAL = /-?(?:0|[1-9]\d*)(?![\d.eE])/y;

function quoteUnsafeIntegers(text: string): string {
  let out = '';
  let last = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      // Skip a string literal (honouring backslash escapes).
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (ch === '-' || (ch !== undefined && ch >= '0' && ch <= '9')) {
      INTEGER_LITERAL.lastIndex = i;
      const match = INTEGER_LITERAL.exec(text);
      if (match) {
        const literal = match[0];
        if (!Number.isSafeInteger(Number(literal))) {
          out += `${text.slice(last, i)}"${literal}"`;
          last = i + literal.length;
        }
        i += literal.length;
        continue;
      }
      // A fraction / exponent number: skip its remaining number characters.
      while (i < text.length && /[-+\d.eE]/.test(text[i] ?? '')) i++;
      continue;
    }
    i++;
  }
  return last === 0 ? text : out + text.slice(last);
}
