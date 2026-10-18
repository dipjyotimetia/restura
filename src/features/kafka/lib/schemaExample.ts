// Example-payload generation for Schema Registry schemas (#982). Produces a
// JSON value shaped like the schema so the producer editor starts from a
// payload the registry encoder accepts. Avro values follow avsc's JS
// representation (unions unwrapped), which is what the Confluent encoder takes.

export type RegistrySchemaKind = 'AVRO' | 'JSON' | 'PROTOBUF';

export type SchemaExampleResult = { ok: true; json: string } | { ok: false; error: string };

const MAX_DEPTH = 8;
/** Total schema nodes visited per example — bounds wide fan-out schemas. */
export const MAX_EXAMPLE_NODES = 5_000;
// Generation is synchronous, so one module-level budget per call is safe.
let nodeBudget = MAX_EXAMPLE_NODES;
const spendNode = (): boolean => {
  nodeBudget -= 1;
  return nodeBudget >= 0;
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type AvroType = string | AvroType[] | { [key: string]: unknown };

const AVRO_PRIMITIVES: Record<string, Json> = {
  null: null,
  boolean: false,
  int: 0,
  long: 0,
  float: 0,
  double: 0,
  bytes: '',
  string: '',
};

function avroExample(
  type: AvroType,
  named: Map<string, AvroType>,
  depth: number,
  namespace = ''
): Json {
  if (depth > MAX_DEPTH || !spendNode()) return null;
  if (typeof type === 'string') {
    if (type in AVRO_PRIMITIVES) return AVRO_PRIMITIVES[type] as Json;
    const ref = named.get(type) ?? [...named.entries()].find(([n]) => n.endsWith(`.${type}`))?.[1];
    return ref === undefined ? null : avroExample(ref, named, depth + 1);
  }
  if (Array.isArray(type)) {
    // Prefer the first non-null branch so optional fields show their shape.
    const branch = type.find((t) => t !== 'null') ?? type[0];
    return branch === undefined ? null : avroExample(branch, named, depth + 1, namespace);
  }
  if (type === null || typeof type !== 'object') return null;
  const t = type as Record<string, unknown>;
  const kind = t.type as AvroType;
  // Named types inherit the enclosing namespace unless they declare their own.
  const ns = typeof t.namespace === 'string' ? t.namespace : namespace;
  if (typeof t.name === 'string' && (kind === 'record' || kind === 'enum' || kind === 'fixed')) {
    named.set(ns && !t.name.includes('.') ? `${ns}.${t.name}` : t.name, type);
    named.set(t.name, type);
  }
  switch (kind) {
    case 'record':
    case 'error': {
      const out: Record<string, Json> = {};
      for (const field of (t.fields as Record<string, unknown>[] | undefined) ?? []) {
        if (typeof field.name !== 'string') continue;
        out[field.name] =
          field.default !== undefined
            ? (field.default as Json)
            : avroExample(field.type as AvroType, named, depth + 1, ns);
      }
      return out;
    }
    case 'enum':
      return Array.isArray(t.symbols) && typeof t.symbols[0] === 'string' ? t.symbols[0] : '';
    case 'array':
      return [avroExample(t.items as AvroType, named, depth + 1, ns)];
    case 'map':
      return { key: avroExample(t.values as AvroType, named, depth + 1, ns) };
    case 'fixed':
      // Avro JSON convention: one code point (0-255) per byte, so the
      // example has exactly `size` bytes once the encoder converts it.
      return typeof t.size === 'number' && t.size > 0 && t.size <= 1024
        ? '\u0000'.repeat(t.size)
        : '';
    default:
      // Logical types ({ type: 'long', logicalType: ... }) and wrapped primitives.
      return kind === undefined ? null : avroExample(kind, named, depth + 1);
  }
}

function resolvePointer(root: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let node: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

const STRING_FORMATS: Record<string, string> = {
  'date-time': '1970-01-01T00:00:00Z',
  date: '1970-01-01',
  time: '00:00:00Z',
  email: 'user@example.com',
  uri: 'https://example.com',
  uuid: '00000000-0000-0000-0000-000000000000',
  hostname: 'example.com',
  ipv4: '192.0.2.1',
};

function jsonSchemaExample(schema: unknown, root: Record<string, unknown>, depth: number): Json {
  if (depth > MAX_DEPTH || !spendNode()) return null;
  if (schema === true || !schema || typeof schema !== 'object') return null;
  const s = schema as Record<string, unknown>;
  if (s.const !== undefined) return s.const as Json;
  if (Array.isArray(s.examples) && s.examples.length > 0) return s.examples[0] as Json;
  if (s.default !== undefined) return s.default as Json;
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0] as Json;
  if (typeof s.$ref === 'string') {
    return jsonSchemaExample(resolvePointer(root, s.$ref), root, depth + 1);
  }
  for (const key of ['oneOf', 'anyOf'] as const) {
    const options = s[key];
    if (Array.isArray(options) && options.length > 0) {
      const first = options.find((o) => (o as { type?: unknown })?.type !== 'null') ?? options[0];
      return jsonSchemaExample(first, root, depth + 1);
    }
  }
  if (Array.isArray(s.allOf)) {
    const merged: Record<string, Json> = {};
    for (const part of s.allOf) {
      const value = jsonSchemaExample(part, root, depth + 1);
      if (value && typeof value === 'object' && !Array.isArray(value)) Object.assign(merged, value);
    }
    return merged;
  }
  const type = Array.isArray(s.type) ? (s.type.find((t) => t !== 'null') ?? s.type[0]) : s.type;
  switch (type ?? (s.properties ? 'object' : s.items ? 'array' : undefined)) {
    case 'object': {
      const out: Record<string, Json> = {};
      const props = (s.properties as Record<string, unknown> | undefined) ?? {};
      for (const [name, prop] of Object.entries(props)) {
        out[name] = jsonSchemaExample(prop, root, depth + 1);
      }
      return out;
    }
    case 'array': {
      const items = Array.isArray(s.items) ? s.items[0] : s.items;
      return items === undefined ? [] : [jsonSchemaExample(items, root, depth + 1)];
    }
    case 'string':
      return typeof s.format === 'string' ? (STRING_FORMATS[s.format] ?? '') : '';
    case 'integer':
    case 'number':
      return typeof s.minimum === 'number' ? s.minimum : 0;
    case 'boolean':
      return false;
    default:
      return null;
  }
}

/** Generate a pretty-printed example payload for a registry schema. */
export function generateSchemaExample(
  schemaType: RegistrySchemaKind,
  schemaText: string
): SchemaExampleResult {
  if (schemaType === 'PROTOBUF') {
    return { ok: false, error: 'Example generation supports Avro and JSON Schema.' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(schemaText);
  } catch {
    return { ok: false, error: 'The schema is not valid JSON.' };
  }
  nodeBudget = MAX_EXAMPLE_NODES;
  const value =
    schemaType === 'AVRO'
      ? avroExample(parsed as AvroType, new Map(), 0)
      : jsonSchemaExample(parsed, (parsed ?? {}) as Record<string, unknown>, 0);
  return { ok: true, json: JSON.stringify(value, null, 2) };
}

/** Pretty-print JSON-based schemas for the read-only viewer; Protobuf is shown as-is. */
export function formatSchemaText(schemaType: RegistrySchemaKind, schemaText: string): string {
  if (schemaType === 'PROTOBUF') return schemaText;
  try {
    return JSON.stringify(JSON.parse(schemaText), null, 2);
  } catch {
    return schemaText;
  }
}
