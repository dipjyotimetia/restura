/**
 * gRPC schema snapshot helpers (#871 / #921 / #937).
 *
 * A saved `GrpcRequest` carries an optional `schema` snapshot (reflection
 * descriptors or uploaded `.proto` text) and `timeout`, so it can run outside
 * the builder — the desktop collection runner, a reopened tab, an imported
 * collection. These helpers translate the snapshot into the `protocolOptions`
 * shape `grpcProtocol.runRequest` consumes, and provide the reflection
 * fallback used when a request has no snapshot.
 */
import { grpcSchemaHash } from '@shared/opencollection/grpc-schema-extension';
import {
  diffGrpcRegistries,
  type GrpcSchemaDiff,
  registryFromSnapshot,
} from '@shared/protocol/grpc-schema-drift';
import type { GrpcRequest, GrpcSchemaSnapshot, ReflectionServiceInfo, Request } from '@/types';
import { grpcDeadlineMs, NO_GRPC_DEADLINE } from './grpcDeadline';
import { GrpcReflectionClient, type ReflectionCredentials } from './grpcReflection';

export interface GrpcSchemaRunOptions {
  descriptors?: string[];
  protoContent?: string;
  protoFileName?: string;
  timeoutMs?: number;
}

/** Map a request's persisted snapshot + timeout onto gRPC protocolOptions. */
export function grpcRunOptionsFromRequest(request: GrpcRequest): GrpcSchemaRunOptions {
  const out: GrpcSchemaRunOptions = {};
  const schema = request.schema;
  if (schema?.kind === 'descriptors' && schema.descriptors.length > 0) {
    out.descriptors = schema.descriptors;
  } else if (schema?.kind === 'proto' && schema.text) {
    out.protoContent = schema.text;
    out.protoFileName = schema.fileName || 'schema.proto';
  }
  // Streaming "No deadline" yields 0 (runner honours it); unary always gets a deadline.
  if (typeof request.timeout === 'number') {
    const ms = grpcDeadlineMs(request);
    if (request.timeout > 0 || ms === NO_GRPC_DEADLINE) out.timeoutMs = ms;
  }
  return out;
}

/** True when the snapshot came from a user upload rather than server reflection. */
export function isUploadedSchema(schema: GrpcSchemaSnapshot | undefined): boolean {
  return schema?.kind === 'proto' || (schema?.kind === 'descriptors' && Boolean(schema.fileName));
}

/**
 * Stamp snapshot content with provenance (#937): the content hash (identical
 * to the `x-restura-grpc` OpenCollection table key) and the capture time.
 */
export function stampSnapshot(
  content: GrpcSchemaSnapshot,
  now: number = Date.now()
): GrpcSchemaSnapshot {
  return { ...content, hash: grpcSchemaHash(content), fetchedAt: now };
}

/** Stamped snapshot of a reflected service, or undefined when reflection carried no descriptors (web). */
export function snapshotFromReflection(
  service: Pick<ReflectionServiceInfo, 'descriptors'>,
  now: number = Date.now()
): GrpcSchemaSnapshot | undefined {
  return service.descriptors?.length
    ? stampSnapshot({ kind: 'descriptors', descriptors: [...service.descriptors] }, now)
    : undefined;
}

/** Content equality — provenance (`hash`, `fetchedAt`) is ignored. */
export function sameSnapshot(
  a: GrpcSchemaSnapshot | undefined,
  b: GrpcSchemaSnapshot | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'proto' && b.kind === 'proto') {
    return a.fileName === b.fileName && a.text === b.text;
  }
  if (a.kind === 'descriptors' && b.kind === 'descriptors') {
    return (
      a.fileName === b.fileName &&
      a.descriptors.length === b.descriptors.length &&
      a.descriptors.every((d, i) => d === b.descriptors[i])
    );
  }
  return false;
}

export type ReflectionSnapshotDecision =
  | { action: 'keep' }
  | { action: 'write'; snapshot: GrpcSchemaSnapshot }
  | { action: 'drift'; snapshot: GrpcSchemaSnapshot; diff: GrpcSchemaDiff };

/**
 * What to do with the request's schema snapshot after the user (or
 * auto-discovery) selects a reflected service:
 *  - `keep` — web reflection carries no descriptors; an uploaded schema
 *    (`.proto`, or descriptors from a multi-file / FileDescriptorSet upload —
 *    marked by `fileName`) is an explicit user choice and keeps precedence (as
 *    on Send), so reflection never overwrites it; or the content is unchanged
 *    (not rewritten, so remount-triggered auto-discovery doesn't dirty the tab);
 *  - `write` — no snapshot yet, the bytes changed without any semantic schema
 *    change, the saved snapshot can't be decoded (nothing to compare), or it
 *    doesn't define the selected service — the user switched to a service from
 *    a different file, so the old snapshot is a different schema, not an older
 *    version of this one;
 *  - `drift` (#937) — the server schema changed since the snapshot was saved.
 *    The saved snapshot is held until the user accepts the new one, and the
 *    classified diff (breaking vs non-breaking) is surfaced.
 */
export function reflectionSnapshotDecision(
  service: Pick<ReflectionServiceInfo, 'descriptors'> &
    Partial<Pick<ReflectionServiceInfo, 'fullName'>>,
  current: Request | undefined,
  now: number = Date.now()
): ReflectionSnapshotDecision {
  const snapshot = snapshotFromReflection(service, now);
  const existing = current?.type === 'grpc' ? current.schema : undefined;
  if (!snapshot || isUploadedSchema(existing) || sameSnapshot(existing, snapshot)) {
    return { action: 'keep' };
  }
  if (!existing) return { action: 'write', snapshot };
  let diff: GrpcSchemaDiff;
  try {
    const saved = registryFromSnapshot(existing);
    if (service.fullName && !saved.getService(service.fullName)) {
      return { action: 'write', snapshot };
    }
    diff = diffGrpcRegistries(saved, registryFromSnapshot(snapshot));
  } catch {
    return { action: 'write', snapshot };
  }
  return diff.changes.length === 0
    ? { action: 'write', snapshot }
    : { action: 'drift', snapshot, diff };
}

// One discoverServices() fans out into several reflection round-trips
// (list + one per service + transitive file closure), so a collection run with
// N snapshot-less requests against one server would otherwise reflect N times.
// Cache successful discoveries briefly, keyed by resolved URL. Only
// credential-free discoveries are cached: what reflection exposes can depend on
// the caller's identity, so a credentialed result must never be served to a
// request carrying different (or no) credentials.
const REFLECTION_CACHE_TTL_MS = 30_000;
const reflectionCache = new Map<string, { at: number; services: ReflectionServiceInfo[] }>();

/** @internal test seam */
export function clearReflectionFallbackCache(): void {
  reflectionCache.clear();
}

function hasReflectionCredentials(credentials: ReflectionCredentials | undefined): boolean {
  return Boolean(credentials && (credentials.auth || Object.keys(credentials.metadata).length > 0));
}

function actionableError(service: string, url: string, reason: string): Error {
  return new Error(
    `No gRPC schema saved for ${service || 'this request'} and server reflection at ${url} ${reason}. ` +
      'Open the request and click Discover (reflection) or upload a .proto, then save it to the collection.'
  );
}

/**
 * Fallback for a request with no persisted snapshot: discover the service via
 * server reflection and return its descriptor set. Throws an actionable error
 * when reflection is unavailable or doesn't expose the service.
 */
export async function discoverDescriptorsForRequest(
  resolvedUrl: string,
  service: string,
  /** The request's metadata/auth, so reflection behind an auth gateway works (#887). */
  credentials?: ReflectionCredentials
): Promise<string[]> {
  const now = Date.now();
  const cacheable = !hasReflectionCredentials(credentials);
  let services = cacheable ? reflectionCache.get(resolvedUrl) : undefined;
  if (!services || now - services.at > REFLECTION_CACHE_TTL_MS) {
    let result: Awaited<ReturnType<GrpcReflectionClient['discoverServices']>>;
    try {
      result = await new GrpcReflectionClient(
        resolvedUrl,
        undefined,
        credentials
      ).discoverServices();
    } catch (err) {
      throw actionableError(
        service,
        resolvedUrl,
        `failed (${err instanceof Error ? err.message : String(err)})`
      );
    }
    if (!result.success) {
      throw actionableError(service, resolvedUrl, `failed (${result.error ?? 'unknown error'})`);
    }
    services = { at: now, services: result.services };
    if (cacheable) reflectionCache.set(resolvedUrl, services);
  }
  const match = services.services.find((s) => s.fullName === service);
  if (!match) {
    throw actionableError(service, resolvedUrl, 'does not expose that service');
  }
  if (!match.descriptors?.length) {
    throw actionableError(service, resolvedUrl, 'returned no descriptors for it');
  }
  return match.descriptors;
}
