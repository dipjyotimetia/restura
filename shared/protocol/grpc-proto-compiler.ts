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
import { create, type DescFile, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  type FileDescriptorProto,
  FileDescriptorProtoSchema,
  FileDescriptorSetSchema,
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
} from '@bufbuild/protobuf/wkt';
import * as protobuf from 'protobufjs';
import descriptorExt from 'protobufjs/ext/descriptor';
import { BUNDLED_PROTO_SOURCES } from './grpc-bundled-protos';

/** One uploaded `.proto` source. `path` is its import path (e.g. `foo/v1/bar.proto`). */
export interface ProtoSourceFile {
  path: string;
  content: string;
}

/** An `import` that could not be resolved against the uploaded files, WKTs, or bundled protos. */
export class ProtoImportError extends Error {
  constructor(
    public readonly importPath: string,
    public readonly importedBy: string
  ) {
    super(
      `Cannot resolve import "${importPath}" (imported by ${importedBy}). ` +
        'Upload the imported file alongside it (select several files or a folder), ' +
        'upload a FileDescriptorSet (.binpb / .protoset), or use server reflection.'
    );
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
  return WKT_FILES[path]?.proto;
}

/** True for paths served from the built-in WKT / bundled set (not user uploads). */
export function isBuiltinProtoPath(path: string): boolean {
  return path in WKT_FILES || path in BUNDLED_PROTO_SOURCES;
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
  return protoName.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
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
      if (f.name) f.jsonName = toJsonName(f.name);
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
    if (want in WKT_FILES) return { kind: 'wkt', path: want };
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
    if (want in BUNDLED_PROTO_SOURCES) return { kind: 'source', path: want };
    return null;
  };
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
    if (err instanceof ProtoImportError) throw err;
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
  const root =
    wktProtos.size > 0
      ? protobuf.Root.fromDescriptor(
          toBinary(
            FileDescriptorSetSchema,
            create(FileDescriptorSetSchema, { file: [...wktProtos.values()] })
          )
        )
      : new protobuf.Root();
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
    const fd = {
      name: file.path,
      package: file.pkg || undefined,
      dependency: [...new Set(file.deps)],
      syntax: file.syntax,
      messageType: own
        .filter((o): o is protobuf.Type => o instanceof protobuf.Type)
        .map((t) =>
          (t as unknown as { toDescriptor(e: string): unknown }).toDescriptor(file.syntax)
        ),
      enumType: own
        .filter((o): o is protobuf.Enum => o instanceof protobuf.Enum)
        .map((e) => (e as unknown as { toDescriptor(): unknown }).toDescriptor()),
      service: own
        .filter((o): o is protobuf.Service => o instanceof protobuf.Service)
        .map((s) => (s as unknown as { toDescriptor(): unknown }).toDescriptor()),
    };
    repairDescriptor(fd.messageType as DescriptorLike[], root, file.pkg);
    const msg = descriptorExt.FileDescriptorProto.create(fd as never);
    const bytes = descriptorExt.FileDescriptorProto.encode(msg).finish();
    emitted.set(file.path, fromBinary(FileDescriptorProtoSchema, bytes));
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
