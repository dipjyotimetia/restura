// Backend-agnostic runtime gRPC descriptor registry.
//
// ConnectRPC clients need a `DescService` / `DescMethod` to drive a call, but
// Restura discovers schemas at RUNTIME — users upload a `.proto` or hit server
// reflection. This module turns either source into a `@bufbuild/protobuf`
// `Registry` (no code generation), which the Connect transports consume
// identically on every backend (renderer via connect-web, Electron/Node via
// connect-node).
//
// Two sources:
//  - `registryFromDescriptors`: base64 `FileDescriptorProto`s from server
//    reflection (lossless — enums / WKT / maps / oneofs / cross-file refs all
//    survive). Preferred path.
//  - `registryFromProtoText` / `registryFromProtoFiles`: hand-written `.proto`
//    source(s), compiled by `grpc-proto-compiler` (protobufjs parser → protoc-
//    shaped per-file descriptors). Imports resolve against the other uploaded
//    files, the google/protobuf well-known types, and a few bundled google/api
//    protos.
//  - `descriptorsFromDescriptorSet`: a protoc `FileDescriptorSet`
//    (`.binpb` / `.protoset` / `.desc`) split into the reflection shape above.
//
// Pure + dependency-free of any Node/Electron API so it loads in the renderer,
// the Cloudflare Worker, and the Electron main process alike.
import {
  create,
  createFileRegistry,
  type DescMethod,
  type DescService,
  fromBinary,
  fromJson,
  type JsonValue,
  type Registry,
  toBinary,
  toJson,
} from '@bufbuild/protobuf';
import {
  type FileDescriptorProto,
  FileDescriptorProtoSchema,
  FileDescriptorSetSchema,
} from '@bufbuild/protobuf/wkt';
import {
  compileProtoFiles,
  type DescriptorLike,
  type ProtoSourceFile,
  toJsonName,
  wellKnownFileProto,
} from './grpc-proto-compiler';

export { ProtoImportError, type ProtoSourceFile } from './grpc-proto-compiler';

/** Restura's call-type discriminator (matches `GrpcRequest.methodType`). */
export type GrpcCallKind =
  | 'unary'
  | 'server-streaming'
  | 'client-streaming'
  | 'bidirectional-streaming';

/** Portable base64 → bytes (atob exists in browser, workerd, and Node 24+). */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// A built Registry is immutable and deterministic from its input bytes, so it
// can be reused. Building one (protobufjs parse / bufbuild decode +
// createFileRegistry) is tens of ms — wasteful to repeat per request, notably
// on collection/load runs that fire the same request N times. Cache by content,
// bounded (user schemas are unbounded, so an unbounded map would leak).
const REGISTRY_CACHE_MAX = 50;
const registryCache = new Map<string, Registry>();
function cachedRegistry(key: string, build: () => Registry): Registry {
  const hit = registryCache.get(key);
  if (hit) {
    registryCache.delete(key); // move to most-recently-used
    registryCache.set(key, hit);
    return hit;
  }
  const reg = build();
  registryCache.set(key, reg);
  if (registryCache.size > REGISTRY_CACHE_MAX) {
    const oldest = registryCache.keys().next().value;
    if (oldest !== undefined) registryCache.delete(oldest);
  }
  return reg;
}

/** Portable bytes → base64 (btoa exists in browser, workerd, and Node 24+). */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/**
 * Order a descriptor list dependencies-first (createFileRegistry resolves each
 * file against the ones already added) and back-fill any google/protobuf WKT a
 * set references but omits (`protoc` without `--include_imports`). A missing
 * non-WKT dependency throws naming the import.
 */
function closeAndOrder(files: FileDescriptorProto[]): FileDescriptorProto[] {
  const byName = new Map(files.map((f) => [f.name, f]));
  const ordered: FileDescriptorProto[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (fd: FileDescriptorProto) => {
    if (state.has(fd.name)) return; // done, or a cycle createFileRegistry reports
    state.set(fd.name, 'visiting');
    for (const dep of fd.dependency) {
      let depFile = byName.get(dep);
      if (!depFile) {
        depFile = wellKnownFileProto(dep);
        if (!depFile) {
          throw new Error(
            `Descriptor set is missing "${dep}" (imported by ${fd.name}). ` +
              'Regenerate it with all imports included (protoc --include_imports / buf build).'
          );
        }
        byName.set(dep, depFile);
      }
      visit(depFile);
    }
    state.set(fd.name, 'done');
    ordered.push(fd);
  };
  for (const fd of files) visit(fd);
  return ordered;
}

/**
 * Build a registry from base64 `FileDescriptorProto`s (server reflection, or a
 * FileDescriptorSet upload split by `descriptorsFromDescriptorSet`). The list
 * should include every transitive dependency; missing WKTs are back-filled and
 * the files are ordered dependencies-first before `createFileRegistry`.
 */
export function registryFromDescriptors(base64Descriptors: string[]): Registry {
  if (base64Descriptors.length === 0) {
    throw new Error('No reflection descriptors provided');
  }
  return cachedRegistry(`d:${base64Descriptors.join('\x00')}`, () => {
    const file = base64Descriptors.map((b64) => {
      const fd = fromBinary(FileDescriptorProtoSchema, base64ToBytes(b64));
      fixEmptyJsonNames(fd.messageType as DescriptorLike[]);
      return fd;
    });
    return createFileRegistry(create(FileDescriptorSetSchema, { file: closeAndOrder(file) }));
  });
}

/**
 * Split a binary `google.protobuf.FileDescriptorSet` (`protoc -o x.binpb
 * --include_imports`, `buf build -o x.binpb`, grpcurl `.protoset`) into
 * per-file base64 FileDescriptorProtos — the same shape reflection yields, so
 * it persists and travels through every harness unchanged. Validates by
 * building the registry (throws on a malformed set or a missing import).
 */
export function descriptorsFromDescriptorSet(bytes: Uint8Array): string[] {
  let set: ReturnType<typeof fromBinary<typeof FileDescriptorSetSchema>>;
  try {
    set = fromBinary(FileDescriptorSetSchema, bytes);
  } catch (err) {
    throw new Error(
      `Not a valid FileDescriptorSet: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (set.file.length === 0) throw new Error('FileDescriptorSet contains no files');
  const descriptors = set.file.map((f) => bytesToBase64(toBinary(FileDescriptorProtoSchema, f)));
  registryFromDescriptors(descriptors);
  return descriptors;
}

/**
 * Compile several `.proto` sources (multi-file / folder upload) into per-file
 * base64 FileDescriptorProtos — the full dependency closure incl. WKTs — so the
 * upload persists and travels exactly like a reflection snapshot.
 */
export function descriptorsFromProtoFiles(files: ProtoSourceFile[]): string[] {
  return compileProtoFiles(files).map((fd) =>
    bytesToBase64(toBinary(FileDescriptorProtoSchema, fd))
  );
}

/** Build a registry straight from `.proto` sources (see `compileProtoFiles`). */
export function registryFromProtoFiles(files: ProtoSourceFile[]): Registry {
  const key = `f:${JSON.stringify(files.map((f) => [f.path, f.content]))}`;
  return cachedRegistry(key, () =>
    createFileRegistry(create(FileDescriptorSetSchema, { file: compileProtoFiles(files) }))
  );
}

/**
 * Reflection descriptors from some servers — notably Node servers built on
 * `@grpc/proto-loader` (which generates descriptors via protobufjs) — carry an
 * explicit EMPTY `json_name` on every field. bufbuild treats a present
 * `json_name` as authoritative, so every field would serialise under the key
 * `""` (and collide with each other). Restore the canonical camelCase name so
 * `toJson`/`fromJson` map fields correctly. A non-empty custom `json_name` is
 * preserved untouched.
 */
function fixEmptyJsonNames(messageTypes: DescriptorLike[] = []): void {
  for (const mt of messageTypes) {
    for (const f of mt.field ?? []) {
      if (f.name && !f.jsonName) f.jsonName = toJsonName(f.name);
    }
    fixEmptyJsonNames(mt.nestedType);
  }
}

/**
 * Build a registry from a single `.proto` source text. Imports of the
 * google/protobuf well-known types (and the bundled google/api protos) resolve
 * automatically; importing any other file throws a `ProtoImportError` naming
 * it — upload the files together (`registryFromProtoFiles`) or use reflection.
 */
export function registryFromProtoText(protoText: string, fileName = 'schema.proto'): Registry {
  return registryFromProtoFiles([{ path: fileName, content: protoText }]);
}

/**
 * Resolve a service + method by their proto names (e.g. `echo.v1.EchoService`,
 * `UnaryEcho`). Throws with a clear message if either is missing so a bad
 * service/method surfaces as a setup error rather than a hung call.
 */
export function resolveMethod(
  registry: Registry,
  serviceName: string,
  methodName: string
): { service: DescService; method: DescMethod } {
  const service = registry.getService(serviceName);
  if (!service) {
    throw new Error(`Service "${serviceName}" not found in proto`);
  }
  const method = service.methods.find((m) => m.name === methodName);
  if (!method) {
    throw new Error(`Method "${methodName}" not found on service "${serviceName}"`);
  }
  return { service, method };
}

/** A service as listed for the method picker (type names fully qualified, no leading dot). */
export interface RegistryServiceInfo {
  name: string;
  fullName: string;
  methods: Array<{
    name: string;
    inputType: string;
    outputType: string;
    clientStreaming: boolean;
    serverStreaming: boolean;
  }>;
}

/**
 * Every service in a registry with its methods, in declaration order — read off
 * the real descriptors, so package-qualified, nested and leading-dot type
 * references are all listed (a regex over the `.proto` text dropped them).
 */
export function listServices(registry: Registry): RegistryServiceInfo[] {
  const out: RegistryServiceInfo[] = [];
  for (const desc of registry) {
    if (desc.kind !== 'service') continue;
    out.push({
      name: desc.name,
      fullName: desc.typeName,
      methods: desc.methods.map((m) => ({
        name: m.name,
        inputType: m.input.typeName,
        outputType: m.output.typeName,
        clientStreaming: m.methodKind === 'client_streaming' || m.methodKind === 'bidi_streaming',
        serverStreaming: m.methodKind === 'server_streaming' || m.methodKind === 'bidi_streaming',
      })),
    });
  }
  return out;
}

/** Map a bufbuild `DescMethod.methodKind` to Restura's `GrpcCallKind`. */
export function callKindOf(method: DescMethod): GrpcCallKind {
  switch (method.methodKind) {
    case 'unary':
      return 'unary';
    case 'server_streaming':
      return 'server-streaming';
    case 'client_streaming':
      return 'client-streaming';
    case 'bidi_streaming':
      return 'bidirectional-streaming';
  }
}

/**
 * Parse editor JSON into a method-input message. Uses protobuf JSON semantics
 * (accepts both camelCase `jsonName` and the original snake_case field name)
 * and ignores unknown fields so a partially-filled request body still sends.
 */
export function inputFromJson(method: DescMethod, json: unknown): unknown {
  return fromJson(method.input, (json ?? {}) as JsonValue, { ignoreUnknownFields: true });
}

/**
 * Serialise a method-output message back to a JSON value for display.
 * `alwaysEmitImplicit` keeps zero/false/empty fields (e.g. `index: 0`) in the
 * output so the rendered response shows every field, matching what users expect
 * from a gRPC response viewer rather than proto3's default-omitting JSON.
 */
export function outputToJson(method: DescMethod, message: unknown): JsonValue {
  return toJson(method.output, message as Parameters<typeof toJson>[1], {
    alwaysEmitImplicit: true,
  });
}
