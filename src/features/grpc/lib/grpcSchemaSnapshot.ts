/**
 * gRPC schema snapshot helpers (#871 / #921).
 *
 * A saved `GrpcRequest` carries an optional `schema` snapshot (reflection
 * descriptors or uploaded `.proto` text) and `timeout`, so it can run outside
 * the builder — the desktop collection runner, a reopened tab, an imported
 * collection. These helpers translate the snapshot into the `protocolOptions`
 * shape `grpcProtocol.runRequest` consumes, and provide the reflection
 * fallback used when a request has no snapshot.
 */
import type { GrpcRequest, GrpcSchemaSnapshot, ReflectionServiceInfo, Request } from '@/types';
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
  if (typeof request.timeout === 'number' && request.timeout > 0) out.timeoutMs = request.timeout;
  return out;
}

/** True when the snapshot came from a user upload rather than server reflection. */
export function isUploadedSchema(schema: GrpcSchemaSnapshot | undefined): boolean {
  return schema?.kind === 'proto' || (schema?.kind === 'descriptors' && Boolean(schema.fileName));
}

/** Snapshot of a reflected service, or undefined when reflection carried no descriptors (web). */
export function snapshotFromReflection(
  service: Pick<ReflectionServiceInfo, 'descriptors'>
): GrpcSchemaSnapshot | undefined {
  return service.descriptors?.length
    ? { kind: 'descriptors', descriptors: [...service.descriptors] }
    : undefined;
}

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

/**
 * The snapshot to persist after the user (or auto-discovery) selects a
 * reflected service, or undefined when nothing should change:
 *  - web reflection carries no descriptors → nothing to snapshot;
 *  - an uploaded schema (`.proto`, or descriptors from a multi-file /
 *    FileDescriptorSet upload — marked by `fileName`) is an explicit user
 *    choice and keeps precedence (as on Send), so reflection never overwrites it;
 *  - an identical snapshot is not rewritten (avoids dirtying the tab on every
 *    remount-triggered auto-discovery).
 */
export function reflectionSnapshotUpdate(
  service: Pick<ReflectionServiceInfo, 'descriptors'>,
  current: Request | undefined
): GrpcSchemaSnapshot | undefined {
  const snapshot = snapshotFromReflection(service);
  const existing = current?.type === 'grpc' ? current.schema : undefined;
  if (!snapshot || isUploadedSchema(existing) || sameSnapshot(existing, snapshot)) return undefined;
  return snapshot;
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
