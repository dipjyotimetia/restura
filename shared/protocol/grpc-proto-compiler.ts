// Runtime `.proto` → FileDescriptorProto compiler (#891).
//
// `@bufbuild/protobuf` has no `.proto` text parser, so `protobufjs` parses the
// sources and this module re-emits them as protoc-shaped FileDescriptorProtos —
// one per SOURCE FILE, with its `dependency` list, topologically ordered — that
// bufbuild's strict `createFileRegistry` accepts. (protobufjs's own
// `Root#toDescriptor` groups by package and drops imports, which breaks as soon
// as a schema spans more than one file.)
//
// Import resolution, in order:
//  1. `google/protobuf/*.proto` well-known types → bufbuild's canonical embedded
//     descriptors (never parsed from text, so WKT JSON mapping is exact);
//  2. an uploaded file at that exact path, or relative to the importing file;
//  3. an uploaded file whose path ends with the import path (a folder upload
//     rooted above the import root) or, failing that, a unique base-name match
//     (several loose files picked without folder structure);
//  4. the bundled google/api protos (grpc-bundled-protos.ts).
// Anything else fails with a `ProtoImportError` naming the missing import.
//
// Pure + dependency-free of Node/Electron APIs: runs in the renderer, the
// Worker, and the Electron main process alike.
//
// No runtime code generation: the production CSPs (web `_headers`, Electron)
// forbid `unsafe-eval`, and protobufjs builds message classes with
// `Function()` the moment one is created, encoded or decoded. So protobufjs
// is used ONLY as a parser + reflection tree (parse / addJSON / resolveAll are
// eval-free); descriptors are built from that tree directly as bufbuild
// messages, and the well-known types are seeded into it as JSON.
import {
  create,
  type DescEnum,
  type DescField,
  type DescFile,
  type DescMessage,
  type MessageInitShape,
  ScalarType,
} from '@bufbuild/protobuf';
import {
  type DescriptorProto,
  DescriptorProtoSchema,
  type EnumDescriptorProto,
  EnumDescriptorProtoSchema,
  type FieldDescriptorProto,
  FieldDescriptorProtoSchema,
  type FileDescriptorProto,
  FileDescriptorProtoSchema,
  file_google_protobuf_any,
  file_google_protobuf_api,
  file_google_protobuf_descriptor,
  file_google_protobuf_duration,
  file_google_protobuf_empty,
  file_google_protobuf_field_mask,
  file_google_protobuf_source_context,
  file_google_protobuf_struct,
  file_google_protobuf_timestamp,
  file_google_protobuf_type,
  file_google_protobuf_wrappers,
  ServiceDescriptorProtoSchema,
} from '@bufbuild/protobuf/wkt';
import * as protobuf from 'protobufjs';
import { BUNDLED_PROTO_SOURCES } from './grpc-bundled-protos';

/** One uploaded `.proto` source. `path` is its import path (e.g. `foo/v1/bar.proto`). */
export interface ProtoSourceFile {
  path: string;
  content: string;
}

/** An `import` that could not be resolved against the uploaded files, WKTs, or bundled protos. */
export class ProtoImportError extends Error {
  public readonly importPath: string;
  public readonly importedBy: string;

  constructor(importPath: string, importedBy: string) {
    super(
      `Cannot resolve import "${importPath}" (imported by ${importedBy}). ` +
        'Upload the imported file alongside it (select several files or a folder), ' +
        'upload a FileDescriptorSet (.binpb / .protoset), or use server reflection.'
    );
    this.importPath = importPath;
    this.importedBy = importedBy;
    this.name = 'ProtoImportError';
  }
}

const WKT_FILES: Readonly<Record<string, DescFile>> = Object.fromEntries(
  [
    file_google_protobuf_any,
    file_google_protobuf_api,
    file_google_protobuf_descriptor,
    file_google_protobuf_duration,
    file_google_protobuf_empty,
    file_google_protobuf_field_mask,
    file_google_protobuf_source_context,
    file_google_protobuf_struct,
    file_google_protobuf_timestamp,
    file_google_protobuf_type,
    file_google_protobuf_wrappers,
  ].map((f) => [`${f.name}.proto`, f])
);

/** Canonical bufbuild FileDescriptorProto for a google/protobuf WKT path, if known. */
export function wellKnownFileProto(path: string): FileDescriptorProto | undefined {
  return Object.hasOwn(WKT_FILES, path) ? WKT_FILES[path]?.proto : undefined;
}

// ---------------------------------------------------------------------------
// Descriptor repair (protobufjs output → what bufbuild accepts)
// ---------------------------------------------------------------------------

interface FieldDescriptorLike {
  name?: string;
  jsonName?: string;
  /** FieldDescriptorProto.Type: 11 = message, 14 = enum. */
  type?: number;
  typeName?: string;
}
export interface DescriptorLike {
  name?: string;
  field?: FieldDescriptorLike[];
  nestedType?: DescriptorLike[];
  options?: { mapEntry?: boolean };
}

/** proto3 canonical lowerCamelCase JSON name (matches protoc / the spec). */
export function toJsonName(protoName: string): string {
  // protoc's ToJsonName: drop each `_` and upper-case the next character
  // (only a-z changes), so `foo_1bar` → `foo1bar` and `a__b` → `aB`.
  let out = '';
  let upperNext = false;
  for (const c of protoName) {
    if (c === '_') {
      upperNext = true;
    } else {
      out += upperNext ? c.toUpperCase() : c;
      upperNext = false;
    }
  }
  return out;
}

/**
 * Repair protobufjs's DescriptorProto output, recursively:
 *  - `json_name`: protobufjs leaves it empty for no-underscore fields, and
 *    bufbuild reads it verbatim (serialising under ""), so set the canonical one.
 *  - `type_name`: protobufjs emits the SHORT, unqualified name for message-/
 *    enum-typed fields, which bufbuild rejects; use the resolved FQN instead.
 */
function repairDescriptor(
  messageTypes: DescriptorLike[] = [],
  root: protobuf.Root,
  parentFqn: string,
  parentScope: protobuf.Namespace = root
): void {
  for (const mt of messageTypes) {
    const fqn = parentFqn ? `${parentFqn}.${mt.name}` : (mt.name ?? '');
    let protoType: protobuf.Type | null = null;
    try {
      protoType = root.lookup(fqn) as protobuf.Type | null;
    } catch {
      protoType = null;
    }
    // Synthetic map-entry types (`FooEntry`) exist only in the descriptor, not
    // in protobufjs — resolve their value type from the enclosing message.
    const scope = protoType ?? parentScope;
    const mapEntries = new Set(
      (mt.nestedType ?? []).filter((n) => n.options?.mapEntry).map((n) => n.name)
    );
    for (const f of mt.field ?? []) {
      if (f.name && !f.jsonName) f.jsonName = toJsonName(f.name);
      if (f.typeName && mapEntries.has(f.typeName)) {
        // A map field references its synthetic `XxxEntry` type, which must be
        // qualified as nested in this message (not as the map's value type).
        f.typeName = `.${fqn}.${f.typeName}`;
      } else if ((f.type === 11 || f.type === 14) && f.typeName && !f.typeName.startsWith('.')) {
        let resolved = protoType?.fields?.[f.name ?? '']?.resolvedType?.fullName;
        if (!resolved) {
          try {
            resolved = scope.lookupTypeOrEnum(f.typeName).fullName;
          } catch {
            resolved = undefined;
          }
        }
        if (resolved) f.typeName = resolved;
      }
    }
    repairDescriptor(mt.nestedType, root, fqn, scope);
  }
}

// ---------------------------------------------------------------------------
// Import resolution
// ---------------------------------------------------------------------------

/** POSIX-normalise an upload/import path: `\` → `/`, drop `.` / leading `/`, fold `..`. */
export function normalizeProtoPath(path: string): string {
  const out: string[] = [];
  for (const seg of path.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

type Resolved = { kind: 'wkt'; path: string } | { kind: 'source'; path: string };

function makeResolver(uploaded: Map<string, string>) {
  const paths = [...uploaded.keys()];
  return (importPath: string, importer: string): Resolved | null => {
    const want = normalizeProtoPath(importPath);
    if (Object.hasOwn(WKT_FILES, want)) return { kind: 'wkt', path: want };
    if (uploaded.has(want)) return { kind: 'source', path: want };
    const relative = normalizeProtoPath(`${dirname(importer)}/${want}`);
    if (uploaded.has(relative)) return { kind: 'source', path: relative };
    const suffix = paths.filter((p) => p.endsWith(`/${want}`));
    if (suffix.length > 0) {
      // Several candidates: prefer the shortest (closest to an import root).
      return { kind: 'source', path: suffix.sort((a, b) => a.length - b.length)[0] as string };
    }
    const byBase = paths.filter((p) => basename(p) === basename(want));
    if (byBase.length === 1) return { kind: 'source', path: byBase[0] as string };
    if (Object.hasOwn(BUNDLED_PROTO_SOURCES, want)) return { kind: 'source', path: want };
    return null;
  };
}

// ---------------------------------------------------------------------------
// protobufjs reflection → bufbuild descriptors (eval-free)
// ---------------------------------------------------------------------------

// FieldDescriptorProto.Type numbers for protobufjs's scalar type names.
const SCALAR_DESCRIPTOR_TYPE: Readonly<Record<string, number>> = {
  double: 1,
  float: 2,
  int64: 3,
  uint64: 4,
  int32: 5,
  fixed64: 6,
  fixed32: 7,
  bool: 8,
  string: 9,
  bytes: 12,
  uint32: 13,
  sfixed32: 15,
  sfixed64: 16,
  sint32: 17,
  sint64: 18,
};
/**
 * Descriptor type for a protobufjs scalar name. Own-property lookup only: a
 * user message named `constructor` / `toString` must not resolve to an
 * `Object.prototype` member and be emitted as a scalar.
 */
function scalarDescriptorType(type: string): number | undefined {
  return Object.hasOwn(SCALAR_DESCRIPTOR_TYPE, type) ? SCALAR_DESCRIPTOR_TYPE[type] : undefined;
}

const TYPE_GROUP = 10;
const TYPE_MESSAGE = 11;
const TYPE_ENUM = 14;
const LABEL_OPTIONAL = 1;
const LABEL_REQUIRED = 2;
const LABEL_REPEATED = 3;

/** `.pkg.Name` — protobufjs `fullName` already carries the leading dot. */
function qualified(obj: protobuf.ReflectionObject): string {
  return obj.fullName.startsWith('.') ? obj.fullName : `.${obj.fullName}`;
}

/** protoc's map-entry type name: `my_map_field` → `MyMapFieldEntry`. */
export function mapEntryName(fieldName: string): string {
  const camel = fieldName
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return `${camel}Entry`;
}

type FieldInit = MessageInitShape<typeof FieldDescriptorProtoSchema>;

function fieldTypeOf(type: string, resolved: protobuf.ReflectionObject | null, delimited: boolean) {
  const scalar = scalarDescriptorType(type);
  if (scalar !== undefined) return { type: scalar };
  if (resolved instanceof protobuf.Enum) return { type: TYPE_ENUM, typeName: qualified(resolved) };
  if (resolved instanceof protobuf.Type) {
    return { type: delimited ? TYPE_GROUP : TYPE_MESSAGE, typeName: qualified(resolved) };
  }
  throw new Error(`illegal type: ${type}`);
}

function fieldOptions(
  field: protobuf.Field
): { packed?: boolean; deprecated?: boolean } | undefined {
  const opts = field.options as Record<string, unknown> | undefined;
  if (!opts) return undefined;
  const out: { packed?: boolean; deprecated?: boolean } = {};
  if (typeof opts.packed === 'boolean') out.packed = opts.packed;
  if (opts.deprecated === true) out.deprecated = true;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * One message, mirroring protoc: map fields become `repeated XxxEntry` with a
 * synthetic `map_entry` nested type, real oneofs precede the synthetic ones of
 * proto3 `optional` fields, and type references are fully qualified.
 * Extension fields (`extend` blocks) are not emitted, like at file level.
 */
function messageDescriptor(type: protobuf.Type, syntax: 'proto2' | 'proto3'): DescriptorProto {
  // Resolve every field (and map value) type before reading resolvedType.
  // `extend` declarations become "sister" fields on the extended type (named
  // `.pkg.ext`, `declaringField` set) — extensions, not fields of this message.
  const ownFields = type.fieldsArray.filter(
    (f) => !(f as protobuf.Field & { declaringField?: unknown }).declaringField
  );
  for (const f of ownFields) f.resolve();

  const oneofs = type.oneofsArray;
  const isSynthetic = (o: protobuf.OneOf) =>
    o.fieldsArray.length === 1 &&
    (o.fieldsArray[0]?.options as Record<string, unknown> | undefined)?.proto3_optional === true;
  const orderedOneofs = [...oneofs.filter((o) => !isSynthetic(o)), ...oneofs.filter(isSynthetic)];

  const nestedType: DescriptorProto[] = [];
  const field: FieldDescriptorProto[] = [];
  for (const f of ownFields) {
    // An explicit `[json_name = "…"]` wins, as in protoc.
    const explicitJson = (f.options as Record<string, unknown> | undefined)?.json_name;
    const init: FieldInit = {
      name: f.name,
      number: f.id,
      jsonName: typeof explicitJson === 'string' ? explicitJson : toJsonName(f.name),
    };
    if (f instanceof protobuf.MapField) {
      const entry = mapEntryName(f.name);
      init.type = TYPE_MESSAGE;
      init.typeName = `${qualified(type)}.${entry}`;
      init.label = LABEL_REPEATED;
      const keyType = scalarDescriptorType(f.keyType);
      if (keyType === undefined) throw new Error(`illegal map key type: ${f.keyType}`);
      const value = fieldTypeOf(f.type, f.resolvedType, false);
      nestedType.push(
        create(DescriptorProtoSchema, {
          name: entry,
          field: [
            { name: 'key', number: 1, label: LABEL_OPTIONAL, type: keyType, jsonName: 'key' },
            { name: 'value', number: 2, label: LABEL_OPTIONAL, jsonName: 'value', ...value },
          ],
          options: { mapEntry: true },
        })
      );
    } else {
      Object.assign(init, fieldTypeOf(f.type, f.resolvedType, f.delimited === true));
      init.label =
        f.rule === 'repeated'
          ? LABEL_REPEATED
          : f.required && syntax === 'proto2'
            ? LABEL_REQUIRED
            : LABEL_OPTIONAL;
    }
    if (f.partOf) {
      const index = orderedOneofs.indexOf(f.partOf);
      if (index < 0) throw new Error(`missing oneof for field ${f.name}`);
      init.oneofIndex = index;
    }
    const raw = f.options as Record<string, unknown> | undefined;
    if (raw?.default !== undefined && raw.default !== null) init.defaultValue = String(raw.default);
    if (raw?.proto3_optional === true) init.proto3Optional = true;
    const options = fieldOptions(f);
    if (options) init.options = options;
    field.push(create(FieldDescriptorProtoSchema, init));
  }

  for (const nested of type.nestedArray) {
    if (nested instanceof protobuf.Type) nestedType.push(messageDescriptor(nested, syntax));
  }
  const enumType = type.nestedArray
    .filter((n): n is protobuf.Enum => n instanceof protobuf.Enum)
    .map(enumDescriptor);

  const reservedRange: Array<{ start: number; end: number }> = [];
  const reservedName: string[] = [];
  for (const r of type.reserved ?? []) {
    if (typeof r === 'string') reservedName.push(r);
    else reservedRange.push({ start: r[0] as number, end: (r[1] as number) + 1 });
  }
  const extensionRange = (type.extensions ?? []).map((r) => ({
    start: r[0] as number,
    end: (r[1] as number) + 1,
  }));
  const msgOpts = type.options as Record<string, unknown> | undefined;

  return create(DescriptorProtoSchema, {
    name: type.name,
    field,
    nestedType,
    enumType,
    oneofDecl: orderedOneofs.map((o) => ({ name: o.name })),
    extensionRange,
    reservedRange,
    reservedName,
    ...(msgOpts?.deprecated === true ? { options: { deprecated: true } } : {}),
  });
}

function enumDescriptor(e: protobuf.Enum): EnumDescriptorProto {
  const opts = e.options as Record<string, unknown> | undefined;
  const reservedRange: Array<{ start: number; end: number }> = [];
  const reservedName: string[] = [];
  for (const r of e.reserved ?? []) {
    if (typeof r === 'string') reservedName.push(r);
    // EnumReservedRange is end-INCLUSIVE (unlike message reserved ranges).
    else reservedRange.push({ start: r[0] as number, end: r[1] as number });
  }
  const valueOptions = (e as unknown as { valuesOptions?: Record<string, Record<string, unknown>> })
    .valuesOptions;
  return create(EnumDescriptorProtoSchema, {
    name: e.name,
    value: Object.entries(e.values).map(([name, number]) => ({
      name,
      number,
      ...(valueOptions?.[name]?.deprecated === true ? { options: { deprecated: true } } : {}),
    })),
    reservedRange,
    reservedName,
    ...(opts?.allow_alias === true || opts?.deprecated === true
      ? {
          options: {
            ...(opts.allow_alias === true ? { allowAlias: true } : {}),
            ...(opts.deprecated === true ? { deprecated: true } : {}),
          },
        }
      : {}),
  });
}

function serviceDescriptor(svc: protobuf.Service) {
  const opts = svc.options as Record<string, unknown> | undefined;
  return create(ServiceDescriptorProtoSchema, {
    name: svc.name,
    method: svc.methodsArray.map((m) => {
      m.resolve();
      const mOpts = m.options as Record<string, unknown> | undefined;
      return {
        name: m.name,
        inputType: m.resolvedRequestType ? qualified(m.resolvedRequestType) : m.requestType,
        outputType: m.resolvedResponseType ? qualified(m.resolvedResponseType) : m.responseType,
        clientStreaming: m.requestStream === true,
        serverStreaming: m.responseStream === true,
        ...(mOpts?.deprecated === true ? { options: { deprecated: true } } : {}),
      };
    }),
    ...(opts?.deprecated === true ? { options: { deprecated: true } } : {}),
  });
}

// --- well-known types → protobufjs JSON (seeds the parse root, eval-free) ---

const SCALAR_NAME: Readonly<Record<number, string>> = {
  [ScalarType.DOUBLE]: 'double',
  [ScalarType.FLOAT]: 'float',
  [ScalarType.INT64]: 'int64',
  [ScalarType.UINT64]: 'uint64',
  [ScalarType.INT32]: 'int32',
  [ScalarType.FIXED64]: 'fixed64',
  [ScalarType.FIXED32]: 'fixed32',
  [ScalarType.BOOL]: 'bool',
  [ScalarType.STRING]: 'string',
  [ScalarType.BYTES]: 'bytes',
  [ScalarType.UINT32]: 'uint32',
  [ScalarType.SFIXED32]: 'sfixed32',
  [ScalarType.SFIXED64]: 'sfixed64',
  [ScalarType.SINT32]: 'sint32',
  [ScalarType.SINT64]: 'sint64',
};

type JsonNamespace = { nested?: Record<string, JsonNode> };
type JsonNode = JsonNamespace & {
  fields?: Record<string, { type: string; id: number; rule?: string; keyType?: string }>;
  values?: Record<string, number>;
};

function wktFieldJson(f: DescField) {
  const typeOf = (kind: string, scalar?: ScalarType, ref?: { typeName: string }) =>
    kind === 'scalar' ? (SCALAR_NAME[scalar as number] ?? 'bytes') : `.${ref?.typeName}`;
  switch (f.fieldKind) {
    case 'scalar':
      return { type: SCALAR_NAME[f.scalar] ?? 'bytes', id: f.number };
    case 'enum':
      return { type: `.${f.enum.typeName}`, id: f.number };
    case 'message':
      return { type: `.${f.message.typeName}`, id: f.number };
    case 'list':
      return {
        type: typeOf(f.listKind, f.scalar ?? undefined, f.message ?? f.enum ?? undefined),
        id: f.number,
        rule: 'repeated',
      };
    case 'map':
      return {
        keyType: SCALAR_NAME[f.mapKey] ?? 'string',
        type: typeOf(f.mapKind, f.scalar ?? undefined, f.message ?? f.enum ?? undefined),
        id: f.number,
      };
  }
}

function wktEnumJson(e: DescEnum): JsonNode {
  return { values: Object.fromEntries(e.values.map((v) => [v.name, v.number])) };
}

function wktMessageJson(m: DescMessage): JsonNode {
  const nested: Record<string, JsonNode> = {};
  for (const n of m.nestedMessages) nested[n.name] = wktMessageJson(n);
  for (const e of m.nestedEnums) nested[e.name] = wktEnumJson(e);
  return {
    fields: Object.fromEntries(m.fields.map((f) => [f.name, wktFieldJson(f)])),
    ...(Object.keys(nested).length > 0 ? { nested } : {}),
  };
}

/** A bufbuild WKT file as a protobufjs JSON namespace (`google.protobuf.*`). */
function wktNamespaceJson(file: DescFile): JsonNamespace {
  const leaf: Record<string, JsonNode> = {};
  for (const m of file.messages) leaf[m.name] = wktMessageJson(m);
  for (const e of file.enums) leaf[e.name] = wktEnumJson(e);
  let ns: JsonNamespace = { nested: leaf };
  for (const part of file.proto.package.split('.').reverse()) ns = { nested: { [part]: ns } };
  return ns;
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

interface ParsedFile {
  path: string;
  content: string;
  pkg: string;
  syntax: 'proto2' | 'proto3';
  /** Canonical paths of this file's direct imports (WKT or source). */
  deps: string[];
}

function detectSyntax(content: string): 'proto2' | 'proto3' {
  return /^\s*syntax\s*=\s*["']proto2["']/m.test(content) ? 'proto2' : 'proto3';
}

function withFile<T>(path: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(msg.includes(path) ? msg : `${path}: ${msg}`);
  }
}

/**
 * Compile `.proto` sources into bufbuild FileDescriptorProtos — the full
 * closure (uploaded files, bundled google/api files, WKTs) in dependency order,
 * ready for `createFileRegistry`. Throws `ProtoImportError` for a missing import
 * and a file-prefixed error for a parse / unresolved-type failure.
 */
export function compileProtoFiles(files: ProtoSourceFile[]): FileDescriptorProto[] {
  if (files.length === 0) throw new Error('No .proto files provided');
  const uploaded = new Map<string, string>();
  for (const f of files) uploaded.set(normalizeProtoPath(f.path) || 'schema.proto', f.content);
  const resolve = makeResolver(uploaded);

  // 1. Walk the import graph from every uploaded file (pre-parse for imports).
  const parsed = new Map<string, ParsedFile>();
  const wkts = new Set<string>();
  const queue = [...uploaded.keys()];
  while (queue.length > 0) {
    const path = queue.shift() as string;
    if (parsed.has(path)) continue;
    const content = uploaded.get(path) ?? BUNDLED_PROTO_SOURCES[path] ?? '';
    const pre = withFile(path, () => protobuf.parse(content, { keepCase: true }));
    const deps: string[] = [];
    for (const imp of [...(pre.imports ?? []), ...(pre.weakImports ?? [])]) {
      const hit = resolve(imp, path);
      if (!hit) throw new ProtoImportError(imp, path);
      deps.push(hit.path);
      if (hit.kind === 'wkt') wkts.add(hit.path);
      else if (!parsed.has(hit.path)) queue.push(hit.path);
    }
    parsed.set(path, {
      path,
      content,
      pkg: pre.package ?? '',
      syntax: detectSyntax(content),
      deps,
    });
  }

  // 2. WKT closure (api.proto → type.proto → any.proto …), canonical bufbuild protos.
  const wktProtos = new Map<string, FileDescriptorProto>();
  const addWkt = (path: string) => {
    const file = WKT_FILES[path];
    if (!file || wktProtos.has(path)) return;
    for (const dep of file.dependencies) addWkt(`${dep.name}.proto`);
    wktProtos.set(path, file.proto);
  };
  for (const w of wkts) addWkt(w);

  // 3. One protobufjs root seeded with the WKT types, then every source parsed
  //    into it with `parse.filename` set so each declaration remembers its file.
  const root = new protobuf.Root();
  for (const path of wktProtos.keys()) {
    const file = WKT_FILES[path];
    // addJSON takes the namespace's `nested` map, not the namespace itself.
    if (file) root.addJSON(wktNamespaceJson(file).nested ?? {});
  }
  for (const file of parsed.values()) {
    withFile(file.path, () => {
      // `parse.filename` is a static the parser stamps onto each declaration.
      (protobuf.parse as unknown as { filename: string | null }).filename = file.path;
      protobuf.parse(file.content, root, { keepCase: true });
    });
  }
  withFile([...uploaded.keys()].join(', '), () => root.resolveAll());

  // 4. Emit one FileDescriptorProto per source file.
  const emitted = new Map<string, FileDescriptorProto>();
  for (const file of parsed.values()) {
    const ns = (file.pkg ? root.lookup(file.pkg) : root) as protobuf.Namespace | null;
    const own = (ns?.nestedArray ?? []).filter(
      (o) => (o as { filename?: string | null }).filename === file.path
    );
    const fd: MessageInitShape<typeof FileDescriptorProtoSchema> = {
      name: file.path,
      ...(file.pkg ? { package: file.pkg } : {}),
      dependency: [...new Set(file.deps)],
      syntax: file.syntax,
      messageType: own
        .filter((o): o is protobuf.Type => o instanceof protobuf.Type)
        .map((t) => messageDescriptor(t, file.syntax)),
      enumType: own
        .filter((o): o is protobuf.Enum => o instanceof protobuf.Enum)
        .map(enumDescriptor),
      service: own
        .filter((o): o is protobuf.Service => o instanceof protobuf.Service)
        .map(serviceDescriptor),
    };
    repairDescriptor(fd.messageType as unknown as DescriptorLike[], root, file.pkg);
    emitted.set(file.path, create(FileDescriptorProtoSchema, fd));
  }

  // 5. Topological order (dependencies first); WKTs are already ordered.
  const ordered: FileDescriptorProto[] = [...wktProtos.values()];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (path: string, from: string) => {
    if (wktProtos.has(path) || state.get(path) === 'done') return;
    if (state.get(path) === 'visiting') {
      throw new Error(`Import cycle: ${from} → ${path}`);
    }
    state.set(path, 'visiting');
    for (const dep of parsed.get(path)?.deps ?? []) visit(dep, path);
    state.set(path, 'done');
    const fd = emitted.get(path);
    if (fd) ordered.push(fd);
  };
  for (const path of parsed.keys()) visit(path, path);
  return ordered;
}
