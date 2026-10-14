import type {
  CollectionItem,
  GrpcRequest,
  GrpcSchemaSnapshot,
  GrpcWireProtocol,
  Request,
} from '../types';
import {
  applyByPath,
  contentHash,
  createSchemaTable,
  isPathKeyedEntry,
  type PathKeyedEntry,
  readPathKeyedExtension,
  walkRequests,
} from './path-keyed-extension';

/**
 * `extensions['x-restura-grpc']` — Restura-owned, collection-level carrier for
 * gRPC data the canonical OpenCollection gRPC item cannot hold
 * (`GrpcRequest`/`GrpcRequestDetails` are `additionalProperties: false`, and
 * have no schema-snapshot, timeout or wire-protocol slot):
 *
 * ```yaml
 * extensions:
 *   x-restura-grpc:
 *     schemas:
 *       <sha-256 hex>: { kind: descriptors, descriptors: [<base64>...] }
 *     requests:
 *       - path: [Folder, Request name]   # folder names + item name
 *         schema: <sha-256 hex>
 *         schemaFetchedAt: 1760000000000   # snapshot capture time (#937)
 *         timeout: 5000
 *         wireProtocol: grpc-web     # absent = auto
 * ```
 *
 * Snapshots are deduplicated by content hash (many requests against one
 * server share one descriptor set). Requests reference a snapshot by hash;
 * import re-inlines it onto `GrpcRequest.schema`. Snapshot provenance
 * (`hash`, `fetchedAt` — #937) never enters the content-addressed table: the
 * hash IS the table key (recomputed on import) and the capture time rides on
 * the request entry, so equal content still dedupes. Request entries are matched
 * by name path in document order, so duplicate names resolve positionally.
 *
 * The walk / hash-dedupe / path-matching machinery is shared with
 * `x-restura-graphql` (see path-keyed-extension.ts).
 */
export const GRPC_EXTENSION_KEY = 'x-restura-grpc';

interface GrpcExtensionRequestEntry extends PathKeyedEntry {
  schema?: string;
  schemaFetchedAt?: number;
  timeout?: number;
  wireProtocol?: GrpcWireProtocol;
}

const WIRE_PROTOCOLS: ReadonlySet<string> = new Set<GrpcWireProtocol>([
  'grpc',
  'connect',
  'grpc-web',
  'grpc-web-text',
]);

export interface GrpcExtension {
  schemas?: Record<string, GrpcSchemaSnapshot>;
  requests: GrpcExtensionRequestEntry[];
}

/** Canonical (key-ordered) form so equal snapshots hash identically. */
function canonicalSnapshot(s: GrpcSchemaSnapshot): GrpcSchemaSnapshot {
  if (s.kind === 'proto') return { kind: 'proto', fileName: s.fileName, text: s.text };
  return s.fileName
    ? { kind: 'descriptors', descriptors: [...s.descriptors], fileName: s.fileName }
    : { kind: 'descriptors', descriptors: [...s.descriptors] };
}

/** sha-256 hex over the canonical JSON of a snapshot. */
export function grpcSchemaHash(s: GrpcSchemaSnapshot): string {
  return contentHash(canonicalSnapshot(s));
}

const isGrpc = (r: Request): r is GrpcRequest => r.type === 'grpc';

/** Build the extension from the internal tree; undefined when nothing to carry. */
export function buildGrpcExtension(items: CollectionItem[] | undefined): GrpcExtension | undefined {
  const table = createSchemaTable(canonicalSnapshot);
  const requests: GrpcExtensionRequestEntry[] = [];
  walkRequests(items, isGrpc, (req, path) => {
    const entry: GrpcExtensionRequestEntry = { path };
    if (req.schema) {
      entry.schema = table.add(req.schema);
      if (typeof req.schema.fetchedAt === 'number') entry.schemaFetchedAt = req.schema.fetchedAt;
    }
    if (typeof req.timeout === 'number') entry.timeout = req.timeout;
    if (req.wireProtocol) entry.wireProtocol = req.wireProtocol;
    if (
      entry.schema !== undefined ||
      entry.timeout !== undefined ||
      entry.wireProtocol !== undefined
    ) {
      requests.push(entry);
    }
  });
  if (requests.length === 0) return undefined;
  return Object.keys(table.schemas).length > 0
    ? { schemas: table.schemas, requests }
    : { requests };
}

function parseSnapshot(raw: unknown): GrpcSchemaSnapshot | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (
    r.kind === 'descriptors' &&
    Array.isArray(r.descriptors) &&
    r.descriptors.every((d) => typeof d === 'string')
  ) {
    const descriptors = [...(r.descriptors as string[])];
    return typeof r.fileName === 'string' && r.fileName
      ? { kind: 'descriptors', descriptors, fileName: r.fileName }
      : { kind: 'descriptors', descriptors };
  }
  if (r.kind === 'proto' && typeof r.fileName === 'string' && typeof r.text === 'string') {
    return { kind: 'proto', fileName: r.fileName, text: r.text };
  }
  return undefined;
}

/**
 * Re-inline `x-restura-grpc` onto the imported internal tree (mutates the
 * gRPC requests in place). Malformed entries / unknown hashes are ignored —
 * the request simply has no snapshot and the runner falls back to reflection.
 */
export function applyGrpcExtension(items: CollectionItem[] | undefined, raw: unknown): void {
  const ext = readPathKeyedExtension(raw);
  if (!ext) return;
  applyByPath(
    items,
    isGrpc,
    ext.requests,
    (e) => (isPathKeyedEntry(e) ? (e as GrpcExtensionRequestEntry) : undefined),
    (req, entry) => {
      if (typeof entry.schema === 'string') {
        const snapshot = parseSnapshot(ext.schemas[entry.schema]);
        const at = entry.schemaFetchedAt;
        // Provenance is restored only for stamped (post-#937) snapshots, so
        // legacy snapshots round-trip unchanged.
        if (snapshot && typeof at === 'number' && Number.isFinite(at)) {
          req.schema = { ...snapshot, hash: grpcSchemaHash(snapshot), fetchedAt: at };
        } else if (snapshot) req.schema = snapshot;
      }
      if (
        typeof entry.timeout === 'number' &&
        Number.isFinite(entry.timeout) &&
        // 0 = "No deadline" on a streaming request (unary falls back to the default).
        entry.timeout >= 0
      ) {
        req.timeout = entry.timeout;
      }
      if (typeof entry.wireProtocol === 'string' && WIRE_PROTOCOLS.has(entry.wireProtocol)) {
        req.wireProtocol = entry.wireProtocol;
      }
    }
  );
}
