import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { isRecord, isRootFilename } from '../util/oc';

/**
 * On-disk classification of a `.yaml` file inside (or at the root of) an
 * OpenCollection directory layout. See `src/lib/opencollection/fs-reader.ts`
 * and `fs-writer.ts` for the authoring side this mirrors.
 *
 *  - `root`        → `opencollection.{yml,yaml}` (top-level `opencollection:` key)
 *  - `request`     → a per-request file: `info.type ∈ {http,grpc,graphql,websocket}`
 *                    plus the matching sibling protocol key
 *  - `folder-meta` → `_folder.yaml`
 *  - `unknown`     → not part of a collection (or unparseable)
 */
export type OcFileKind = 'root' | 'request' | 'folder-meta' | 'unknown';

/** Protocol kinds that appear as request files in the OpenCollection dir layout. */
export const OC_REQUEST_TYPES = ['http', 'grpc', 'graphql', 'websocket'] as const;
export type OcRequestType = (typeof OC_REQUEST_TYPES)[number];

/**
 * Per-request-type capabilities — the single source of truth for what the
 * extension can do with each protocol.
 *
 *  - `runnableByCli` — the CLI test runner can execute it. GraphQL runs as an
 *    HTTP request; WebSocket is surfaced as a folder (not runnable).
 *  - `sendable` — the inline Send path can map it to a `RequestSpec`. Only the
 *    `http` element shape is mapped today.
 */
export const REQUEST_CAPABILITIES: Record<
  OcRequestType,
  { runnableByCli: boolean; sendable: boolean }
> = {
  http: { runnableByCli: true, sendable: true },
  graphql: { runnableByCli: true, sendable: false },
  grpc: { runnableByCli: true, sendable: false },
  websocket: { runnableByCli: false, sendable: false },
};

const FOLDER_META = '_folder.yaml';

export interface OcRequestInfo {
  kind: 'request';
  type: OcRequestType;
  /** Request display name from `info.name`. */
  name: string;
  /** `info.seq` when present, else `Number.MAX_SAFE_INTEGER` (mirrors fs-reader). */
  seq: number;
  /** The parsed document, exposed so callers don't re-parse the same text. */
  doc: Record<string, unknown>;
}

export type ClassifiedFile = { kind: 'root' | 'folder-meta' | 'unknown' } | OcRequestInfo;

/**
 * Classify a single YAML document by its parsed content + filename. Pure: takes
 * the raw text so it can run against an unsaved editor buffer. Never throws —
 * malformed YAML resolves to `unknown` so a syntax error doesn't crash callers
 * (the diagnostics layer surfaces parse errors separately).
 */
export function classifyOcFile(filePath: string, raw: string): ClassifiedFile {
  const base = path.basename(filePath).toLowerCase();
  if (isRootFilename(base)) return { kind: 'root' };
  if (base === FOLDER_META) return { kind: 'folder-meta' };

  // Cheap pre-check before the (relatively expensive) YAML parse: any real
  // request file contains `info:` and any content-root contains `opencollection`.
  // Skips the parse for the common "unrelated YAML" case (e.g. CodeLens hot path).
  if (!raw.includes('info:') && !raw.includes('opencollection')) return { kind: 'unknown' };

  let doc: unknown;
  try {
    doc = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
  } catch {
    return { kind: 'unknown' };
  }
  if (!isRecord(doc)) return { kind: 'unknown' };

  // A root document carries the top-level `opencollection:` marker even if the
  // file is named unconventionally.
  if (typeof doc.opencollection === 'string') return { kind: 'root' };

  const info = doc.info;
  if (!isRecord(info) || typeof info.type !== 'string') return { kind: 'unknown' };

  const type = info.type;
  if (!(OC_REQUEST_TYPES as readonly string[]).includes(type)) return { kind: 'unknown' };

  // Require BOTH the typed `info` AND the sibling protocol key so unrelated
  // YAML that happens to have an `info.type` field isn't mis-detected.
  if (!isRecord(doc[type])) return { kind: 'unknown' };

  return {
    kind: 'request',
    type: type as OcRequestType,
    name: typeof info.name === 'string' ? info.name : path.basename(filePath),
    seq: typeof info.seq === 'number' ? info.seq : Number.MAX_SAFE_INTEGER,
    doc,
  };
}
