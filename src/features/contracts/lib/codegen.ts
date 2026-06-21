/**
 * Type codegen — turn a response body sample (or an OpenAPI schema) into
 * TypeScript or Zod source code that the user can copy into their codebase.
 *
 * v2 goal: when a user inspects a real API response in Restura, one click
 * produces the matching types — so they can `import` the types in their
 * frontend or backend code without hand-writing them and going out of sync.
 *
 * Two entry points:
 *  - `inferTypeScriptFromSample(value, name)` → TS source for `interface <name>`
 *  - `inferZodFromSample(value, name)` → Zod source for `const <name> = z.object({...})`
 *
 * Both are pure functions — no Ajv, no external libs. The inference is
 * deliberately conservative:
 *  - Strings always become `string` (not literal unions, even for an enum-y
 *    sample). Users can hand-narrow if they want stricter types.
 *  - Numbers become `number`. We don't distinguish int from float — JSON
 *    doesn't differentiate.
 *  - `null` in a position means the field is `T | null` (union, not optional).
 *  - Arrays infer item type from the first element. Heterogeneous arrays
 *    fall back to `unknown[]`.
 *  - Objects walk recursively. Keys with disallowed JS identifier chars
 *    are quoted in TypeScript output and accessed via bracket notation
 *    in Zod output.
 *  - Cyclic input throws — JSON responses don't have cycles in practice.
 *
 * Not in scope (yet):
 *  - JSON Schema $ref resolution from an OpenAPI spec — that's a separate
 *    code path that walks the spec's components and emits one type per
 *    referenced schema. Lands as `generateTypeScriptFromOpenAPI` once
 *    the spec store is wired up.
 *  - Pydantic / Java / Go output. Add by writing a new emitter; the
 *    inference layer is target-independent.
 */

export interface CodegenOptions {
  /** Top-level type/identifier name. Defaults to `Response`. */
  rootName?: string;
  /** Use `readonly` modifiers on TS interface fields. Defaults to `false`. */
  readonly?: boolean;
}

// ---------------------------------------------------------------------------
// Internal IR — a normalized type tree the emitters walk.
// ---------------------------------------------------------------------------

type TypeNode =
  | { kind: 'string' }
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'null' }
  | { kind: 'unknown' }
  | { kind: 'array'; element: TypeNode }
  | { kind: 'object'; properties: Map<string, { type: TypeNode; optional: boolean }> }
  | { kind: 'union'; members: TypeNode[] };

function inferNode(value: unknown, seen: WeakSet<object>): TypeNode {
  if (value === null) return { kind: 'null' };
  if (value === undefined) return { kind: 'unknown' };
  if (typeof value === 'string') return { kind: 'string' };
  if (typeof value === 'number') return { kind: 'number' };
  if (typeof value === 'boolean') return { kind: 'boolean' };
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error('Cyclic input is not supported for codegen');
    seen.add(value);
    if (value.length === 0) return { kind: 'array', element: { kind: 'unknown' } };
    const elementTypes = value.map((v) => inferNode(v, seen));
    return { kind: 'array', element: mergeUnion(elementTypes) };
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new Error('Cyclic input is not supported for codegen');
    seen.add(value);
    const properties = new Map<string, { type: TypeNode; optional: boolean }>();
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      properties.set(k, { type: inferNode(v, seen), optional: false });
    }
    return { kind: 'object', properties };
  }
  return { kind: 'unknown' };
}

function mergeUnion(types: TypeNode[]): TypeNode {
  // Dedup by structural key.
  const seenKeys = new Set<string>();
  const uniq: TypeNode[] = [];
  for (const t of types) {
    const k = structuralKey(t);
    if (!seenKeys.has(k)) {
      seenKeys.add(k);
      uniq.push(t);
    }
  }
  if (uniq.length === 1) return uniq[0]!;

  // If we have a homogeneous object union, merge into one object whose
  // properties are unioned: keys present in only some variants become optional.
  const allObjects = uniq.every((t) => t.kind === 'object');
  if (allObjects) {
    const merged = new Map<string, { type: TypeNode; optional: boolean }>();
    for (const t of uniq) {
      if (t.kind !== 'object') continue;
      for (const [k, prop] of t.properties.entries()) {
        const existing = merged.get(k);
        if (!existing) {
          merged.set(k, prop);
        } else {
          merged.set(k, {
            type: mergeUnion([existing.type, prop.type]),
            optional: existing.optional,
          });
        }
      }
    }
    // Mark properties absent from any variant as optional.
    for (const [k, prop] of merged.entries()) {
      const presentInAll = uniq.every((t) => t.kind === 'object' && t.properties.has(k));
      if (!presentInAll) merged.set(k, { ...prop, optional: true });
    }
    return { kind: 'object', properties: merged };
  }
  return { kind: 'union', members: uniq };
}

function structuralKey(t: TypeNode): string {
  switch (t.kind) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'null':
    case 'unknown':
      return t.kind;
    case 'array':
      return `array<${structuralKey(t.element)}>`;
    case 'union':
      return `union<${t.members.map(structuralKey).sort().join('|')}>`;
    case 'object': {
      const parts: string[] = [];
      for (const [k, prop] of t.properties.entries()) {
        parts.push(`${k}${prop.optional ? '?' : ''}:${structuralKey(prop.type)}`);
      }
      parts.sort();
      return `object<${parts.join(',')}>`;
    }
  }
}

// ---------------------------------------------------------------------------
// TypeScript emitter
// ---------------------------------------------------------------------------

const TS_IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const TS_RESERVED = new Set([
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);

function safeIdentifier(name: string, fallback: string): string {
  if (TS_IDENT_RE.test(name) && !TS_RESERVED.has(name)) return name;
  return fallback;
}

function quoteKey(key: string): string {
  if (TS_IDENT_RE.test(key) && !TS_RESERVED.has(key)) return key;
  return JSON.stringify(key);
}

export function inferTypeScriptFromSample(value: unknown, opts: CodegenOptions = {}): string {
  const rootName = safeIdentifier(opts.rootName ?? 'Response', 'Response');
  const root = inferNode(value, new WeakSet());
  if (root.kind === 'object') {
    return emitTsInterface(rootName, root, opts.readonly === true);
  }
  return `export type ${rootName} = ${emitTsType(root, opts.readonly === true)};\n`;
}

function emitTsInterface(
  name: string,
  node: Extract<TypeNode, { kind: 'object' }>,
  readonly: boolean
): string {
  const lines: string[] = [`export interface ${name} {`];
  for (const [k, prop] of node.properties.entries()) {
    const ro = readonly ? 'readonly ' : '';
    const opt = prop.optional ? '?' : '';
    lines.push(`  ${ro}${quoteKey(k)}${opt}: ${emitTsType(prop.type, readonly)};`);
  }
  lines.push('}', '');
  return lines.join('\n');
}

function emitTsType(node: TypeNode, readonly: boolean): string {
  switch (node.kind) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'unknown':
      return 'unknown';
    case 'array':
      return `${emitTsType(node.element, readonly)}[]`;
    case 'union':
      return node.members.map((m) => emitTsType(m, readonly)).join(' | ');
    case 'object': {
      const parts: string[] = [];
      for (const [k, prop] of node.properties.entries()) {
        const ro = readonly ? 'readonly ' : '';
        const opt = prop.optional ? '?' : '';
        parts.push(`${ro}${quoteKey(k)}${opt}: ${emitTsType(prop.type, readonly)}`);
      }
      return `{ ${parts.join('; ')} }`;
    }
  }
}

// ---------------------------------------------------------------------------
// Zod emitter
// ---------------------------------------------------------------------------

export function inferZodFromSample(value: unknown, opts: CodegenOptions = {}): string {
  const rootName = safeIdentifier(opts.rootName ?? 'Response', 'Response');
  const root = inferNode(value, new WeakSet());
  const expr = emitZodExpr(root);
  return [
    "import { z } from 'zod';",
    '',
    `export const ${rootName} = ${expr};`,
    `export type ${rootName} = z.infer<typeof ${rootName}>;`,
    '',
  ].join('\n');
}

function emitZodExpr(node: TypeNode): string {
  switch (node.kind) {
    case 'string':
      return 'z.string()';
    case 'number':
      return 'z.number()';
    case 'boolean':
      return 'z.boolean()';
    case 'null':
      return 'z.null()';
    case 'unknown':
      return 'z.unknown()';
    case 'array':
      return `z.array(${emitZodExpr(node.element)})`;
    case 'union': {
      const members = node.members.map(emitZodExpr);
      return `z.union([${members.join(', ')}])`;
    }
    case 'object': {
      const parts: string[] = [];
      for (const [k, prop] of node.properties.entries()) {
        let value = emitZodExpr(prop.type);
        if (prop.optional) value = `${value}.optional()`;
        parts.push(`${quoteKey(k)}: ${value}`);
      }
      return `z.object({ ${parts.join(', ')} })`;
    }
  }
}
