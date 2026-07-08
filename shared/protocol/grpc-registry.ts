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
//  - `registryFromProtoText`: a hand-written `.proto`, bridged through
//    `protobufjs` (which has the only runtime `.proto` text parser available;
//    `@bufbuild/protobuf` has none). `protobufjs` is already a dependency and
//    runs in the browser, so this stays backend-agnostic.
//
// Pure + dependency-free of any Node/Electron API so it loads in the renderer,
// the Cloudflare Worker, and the Electron main process alike.
import {
  create,
  createFileRegistry,
  fromBinary,
  fromJson,
  toJson,
  type DescMethod,
  type DescService,
  type JsonValue,
  type Registry,
} from '@bufbuild/protobuf';
import { FileDescriptorProtoSchema, FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt';
import * as protobuf from 'protobufjs';
import descriptorExt from 'protobufjs/ext/descriptor';

/** Restura's call-type discriminator (matches `GrpcRequest.methodType`). */
export type GrpcCallKind =
  'unary' | 'server-streaming' | 'client-streaming' | 'bidirectional-streaming';

/** Minimal protobufjs descriptor shape we walk to fix `json_name` + `type_name`. */
interface FieldDescriptorLike {
  name?: string;
  jsonName?: string;
  /** FieldDescriptorProto.Type: 11 = message, 14 = enum. */
  type?: number;
  typeName?: string;
}
interface DescriptorLike {
  name?: string;
  field?: FieldDescriptorLike[];
  nestedType?: DescriptorLike[];
}
interface FileDescriptorLike {
  package?: string;
  messageType?: DescriptorLike[];
}

/** proto3 canonical lowerCamelCase JSON name (matches protoc / the spec). */
function toJsonName(protoName: string): string {
  return protoName.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Repair protobufjs's FileDescriptorProto output so bufbuild's strict
 * createFileRegistry accepts it, recursively over every message + nested type:
 *  - `json_name`: protobufjs leaves it empty for no-underscore fields, and
 *    bufbuild reads it verbatim (serialising under ""), so set the canonical one.
 *  - `type_name`: protobufjs emits the SHORT, unqualified name for message-/
 *    enum-typed fields (e.g. `ExtensionRequest`), which bufbuild rejects. Use
 *    protobufjs's resolved type (`resolvedType.fullName`, leading-dot FQN) to
 *    fully-qualify it.
 */
function repairDescriptor(
  messageTypes: DescriptorLike[] = [],
  root: protobuf.Root,
  pkg: string,
  parentFqn = ''
): void {
  for (const mt of messageTypes) {
    const fqn = parentFqn ? `${parentFqn}.${mt.name}` : pkg ? `${pkg}.${mt.name}` : (mt.name ?? '');
    const protoType = (() => {
      try {
        return root.lookup(fqn) as protobuf.Type | null;
      } catch {
        return null;
      }
    })();
    for (const f of mt.field ?? []) {
      if (f.name) f.jsonName = toJsonName(f.name);
      if ((f.type === 11 || f.type === 14) && f.typeName && !f.typeName.startsWith('.')) {
        const resolved = protoType?.fields?.[f.name ?? '']?.resolvedType?.fullName;
        if (resolved) f.typeName = resolved;
      }
    }
    repairDescriptor(mt.nestedType, root, pkg, fqn);
  }
}

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

/**
 * Build a registry from base64 `FileDescriptorProto`s (server reflection).
 * The bytes are decoded with bufbuild and assembled into a `FileDescriptorSet`
 * message handed straight to `createFileRegistry` — no manual varint framing.
 * The descriptor list must include every transitive dependency (reflection
 * returns them); `createFileRegistry` resolves cross-file references.
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
    const set = create(FileDescriptorSetSchema, { file });
    return createFileRegistry(set);
  });
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
 * Build a registry from `.proto` source text. `protobufjs` parses the text and
 * emits a `google.protobuf.FileDescriptorSet`, which is re-decoded by bufbuild
 * and registered. `json_name` may be absent from protobufjs output; bufbuild
 * then derives the canonical camelCase JSON name itself, so JSON field mapping
 * stays correct (this is what the old `keepCase` proto-loader path got wrong).
 *
 * Limitation (same as the previous proto-loader path): a `.proto` with `import`
 * statements needs its imported files too; a single uploaded file with imports
 * will fail to resolve. Reflection (above) avoids this.
 */
export function registryFromProtoText(protoText: string): Registry {
  return cachedRegistry(`p:${protoText}`, () => {
    // keepCase: true preserves canonical snake_case field names in the descriptor
    // (keepCase: false rewrites them to camelCase, losing the proto name).
    const parsed = protobuf.parse(protoText, { keepCase: true });
    // `parse` (unlike `load`) leaves type references unresolved; without this the
    // emitted descriptor has bare `input_type: "EchoRequest"` instead of the
    // fully-qualified `.echo.v1.EchoRequest`, which createFileRegistry rejects.
    parsed.root.resolveAll();
    // `toDescriptor` is patched onto Root.prototype by importing ext/descriptor.
    const fdsMessage = parsed.root.toDescriptor('proto3') as unknown as {
      file?: FileDescriptorLike[];
    };
    for (const file of fdsMessage.file ?? []) {
      repairDescriptor(file.messageType, parsed.root, file.package ?? '');
    }
    const bytes = descriptorExt.FileDescriptorSet.encode(fdsMessage).finish();
    return createFileRegistry(fromBinary(FileDescriptorSetSchema, bytes));
  });
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
