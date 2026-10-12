import { sha256HexSync } from '../protocol/crypto-utils';
import type { CollectionItem, GrpcRequest, GrpcSchemaSnapshot } from '../types';

/**
 * `extensions['x-restura-grpc']` — Restura-owned, collection-level carrier for
 * gRPC data the canonical OpenCollection gRPC item cannot hold
 * (`GrpcRequest`/`GrpcRequestDetails` are `additionalProperties: false`, and
 * have no schema-snapshot or timeout slot):
 *
 * ```yaml
 * extensions:
 *   x-restura-grpc:
 *     schemas:
 *       <sha-256 hex>: { kind: descriptors, descriptors: [<base64>...] }
 *     requests:
 *       - path: [Folder, Request name]   # folder names + item name
 *         schema: <sha-256 hex>
 *         timeout: 5000
 * ```
 *
 * Snapshots are deduplicated by content hash (many requests against one
 * server share one descriptor set). Requests reference a snapshot by hash;
 * import re-inlines it onto `GrpcRequest.schema`. Request entries are matched
 * by name path in document order, so duplicate names resolve positionally.
 *
 * Both directions walk the INTERNAL tree: `ocToInternal` preserves folder
 * names, gRPC item names and their relative order, so the export walk and the
 * post-import walk see the same sequence.
 */
export const GRPC_EXTENSION_KEY = 'x-restura-grpc';

interface GrpcExtensionRequestEntry {
  path: string[];
  schema?: string;
  timeout?: number;
}

export interface GrpcExtension {
  schemas?: Record<string, GrpcSchemaSnapshot>;
  requests: GrpcExtensionRequestEntry[];
}

/** Canonical (key-ordered) form so equal snapshots hash identically. */
function canonicalSnapshot(s: GrpcSchemaSnapshot): GrpcSchemaSnapshot {
  return s.kind === 'descriptors'
    ? { kind: 'descriptors', descriptors: [...s.descriptors] }
    : { kind: 'proto', fileName: s.fileName, text: s.text };
}

/** sha-256 hex over the canonical JSON of a snapshot. */
export function grpcSchemaHash(s: GrpcSchemaSnapshot): string {
  return sha256HexSync(JSON.stringify(canonicalSnapshot(s)));
}

function walkGrpc(
  items: CollectionItem[] | undefined,
  parents: string[],
  visit: (req: GrpcRequest, path: string[]) => void
): void {
  for (const it of items ?? []) {
    if (it.type === 'folder') {
      walkGrpc(it.items, [...parents, it.name], visit);
      continue;
    }
    if (it.request?.type === 'grpc') visit(it.request, [...parents, it.name]);
  }
}

/** Build the extension from the internal tree; undefined when nothing to carry. */
export function buildGrpcExtension(items: CollectionItem[] | undefined): GrpcExtension | undefined {
  const schemas: Record<string, GrpcSchemaSnapshot> = {};
  const requests: GrpcExtensionRequestEntry[] = [];
  walkGrpc(items, [], (req, path) => {
    const entry: GrpcExtensionRequestEntry = { path };
    if (req.schema) {
      const hash = grpcSchemaHash(req.schema);
      schemas[hash] ??= canonicalSnapshot(req.schema);
      entry.schema = hash;
    }
    if (typeof req.timeout === 'number') entry.timeout = req.timeout;
    if (entry.schema !== undefined || entry.timeout !== undefined) requests.push(entry);
  });
  if (requests.length === 0) return undefined;
  return Object.keys(schemas).length > 0 ? { schemas, requests } : { requests };
}

function parseSnapshot(raw: unknown): GrpcSchemaSnapshot | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (
    r.kind === 'descriptors' &&
    Array.isArray(r.descriptors) &&
    r.descriptors.every((d) => typeof d === 'string')
  ) {
    return { kind: 'descriptors', descriptors: [...(r.descriptors as string[])] };
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
  if (!raw || typeof raw !== 'object') return;
  const ext = raw as Record<string, unknown>;
  const schemas = (ext.schemas && typeof ext.schemas === 'object' ? ext.schemas : {}) as Record<
    string,
    unknown
  >;
  const pending = (Array.isArray(ext.requests) ? ext.requests : []).filter(
    (e): e is GrpcExtensionRequestEntry =>
      !!e &&
      typeof e === 'object' &&
      Array.isArray((e as { path?: unknown }).path) &&
      (e as { path: unknown[] }).path.every((p) => typeof p === 'string')
  );
  if (pending.length === 0) return;
  const key = (path: string[]) => JSON.stringify(path);
  walkGrpc(items, [], (req, path) => {
    const k = key(path);
    const idx = pending.findIndex((e) => key(e.path) === k);
    if (idx < 0) return;
    const [entry] = pending.splice(idx, 1);
    if (!entry) return;
    if (typeof entry.schema === 'string') {
      const snapshot = parseSnapshot(schemas[entry.schema]);
      if (snapshot) req.schema = snapshot;
    }
    if (typeof entry.timeout === 'number' && Number.isFinite(entry.timeout) && entry.timeout > 0) {
      req.timeout = entry.timeout;
    }
  });
}
