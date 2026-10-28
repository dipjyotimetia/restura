import { isConfiguredAuth } from '../../auth/inheritance';
import type { AuthConfig, Collection, CollectionItem } from '../../types';
import { arr, hasUnsupportedPostmanAuth, isObj, type Raw } from './common';
import { type PostmanExportReport, PostmanExportReportBuilder } from './export-report';
import { writePostmanV3Files } from './export-v3-files';
import { exportGrpc, exportHttp } from './export-v3-http';
import { exportKafka, exportMcp, exportMqtt } from './export-v3-protocols';
import {
  AUTH_TYPES,
  COLLECTION_PHASES,
  defaultExportScript,
  defined,
  type ExportContext,
  exportAuth,
  exportScripts,
  exportVariables,
  isExplicitNoauth,
  restoreBagOnlyAuth,
} from './export-v3-shared';
import { exportSocketIo, exportWebSocket } from './export-v3-streaming';
import { getPostmanSidecar, type PostmanSidecar } from './sidecar';
import type { PostmanV3FileMap } from './v3-container';

/**
 * Runtime-neutral Postman Collection v3 export (#1201, ADR 0034).
 *
 * Restura collection → (a) the v3 logical tree (`$kind: "collection"` root,
 * valid against `vendor/postman/v3.0.0/schema.json`) and (b) the multi-file
 * YAML folder as a `{ relativePath: yaml }` map (`export-v3-files.ts`) that
 * `importPostmanV3Files` reads back.
 *
 * Secrets: callers apply the export "include secrets" choice
 * (`redactCollectionSecrets`) BEFORE calling this, so typed fields and the
 * `_postman` sidecar are already redacted. On top of that, secret variables
 * and keychain-handle values are always written EMPTY (and reported).
 *
 * The `_postman` sidecar is read to restore what the importer could not
 * model (examples, unsupported auth, settings leftovers, placeholder items,
 * original methods, path variables, folder descriptions, broker leftovers),
 * so import → export round-trips. It is never written into the files as-is.
 * Restura-only data v3 cannot hold is dropped and listed in the report.
 */

export type {
  PostmanExportConstruct,
  PostmanExportIssue,
  PostmanExportReport,
} from './export-report';

export interface PostmanV3ExportOptions {
  /** Applied to every script (default: the `rs.*` → `pm.*` migration). */
  transformScript?: (script: string) => string;
}

export interface PostmanV3Export {
  /** The v3 logical tree. */
  tree: Raw;
  /** The on-disk folder, `{ relativePath: yaml }`, without a wrapper directory. */
  files: PostmanV3FileMap;
  report: PostmanExportReport;
}

/** Placeholder folder created at import for a v3 item kind Restura cannot model. */
function placeholderItem(
  item: CollectionItem,
  sidecar: PostmanSidecar | undefined,
  ctx: ExportContext
): Raw | null {
  if (item.type !== 'folder' || (item.items?.length ?? 0) > 0) return null;
  const raw = sidecar?.item;
  if (!isObj(raw) || typeof raw.$kind !== 'string' || raw.$kind === 'collection') return null;
  const { auth: _auth, ...rest } = raw;
  const allowed =
    raw.$kind === 'websocket-request'
      ? AUTH_TYPES.websocket
      : raw.$kind === 'llm-request'
        ? AUTH_TYPES.llm
        : raw.$kind === 'mcp-request'
          ? AUTH_TYPES.mcp
          : undefined;
  const auth = allowed
    ? restoreBagOnlyAuth(sidecar, allowed, item.name || 'Untitled', ctx)
    : undefined;
  if (raw.$kind === 'mcp-request') return defined({ ...stdioPlaceholder(rest), auth });
  return defined({ ...rest, auth });
}

/**
 * A stdio MCP placeholder bag (`keepMcpStdio`) → a schema-valid stdio
 * `mcp-request`: the bag's own `argv` (the split command, for the warning)
 * is not a v3 field and is dropped — the already-scrubbed `command` carries
 * the launch line — and env rows, kept as names only, are written with
 * EMPTY values (`value` is required by `v3-key-value-meta`).
 */
function stdioPlaceholder(raw: Raw): Raw {
  const { argv: _argv, env, ...rest } = raw;
  const rows = arr(env)
    .filter(isObj)
    .filter((e) => typeof e.key === 'string')
    .map((e) =>
      defined({ key: e.key, value: '', disabled: e.disabled === true ? true : undefined })
    );
  return { ...rest, env: rows.length > 0 ? rows : undefined };
}

function exportRequest(
  item: CollectionItem,
  inherited: AuthConfig | undefined,
  sidecar: PostmanSidecar | undefined,
  ctx: ExportContext
): Raw | null {
  const req = item.request;
  if (!req) return null;
  const name = item.name || req.name || 'Untitled';
  switch (req.type) {
    case 'http':
      return exportHttp(req, name, inherited, sidecar, ctx).item;
    case 'grpc':
      return exportGrpc(req, name, inherited, sidecar, ctx).item;
    case 'mcp':
      return exportMcp(req, name, inherited, sidecar, ctx).item;
    case 'mqtt':
      return exportMqtt(req, name, sidecar, ctx).item;
    case 'kafka':
      return exportKafka(req, name, sidecar, ctx).item;
    case 'websocket':
      return exportWebSocket(req, name, sidecar, ctx).item;
    case 'socketio':
      return exportSocketIo(req, name, sidecar, ctx).item;
    case 'sse':
      ctx.report.dropped('sse-request', name);
      return null;
    default:
      return null;
  }
}

function containerAuth(
  auth: AuthConfig | undefined,
  sidecar: PostmanSidecar | undefined,
  owner: string,
  ctx: ExportContext,
  emitNone: boolean
): Raw | undefined {
  if (isExplicitNoauth(auth, sidecar)) return { type: 'noauth' };
  const bagAuth = sidecar?.auth !== undefined && !sidecar.authBagOnly;
  if (!bagAuth && !isConfiguredAuth(auth) && !(emitNone && auth)) return undefined;
  return exportAuth(auth ?? { type: 'none' }, sidecar, AUTH_TYPES.collection, owner, ctx);
}

/**
 * The auth a container hands its children for inheritance detection. A
 * container whose own auth is an UNSUPPORTED Postman type (hawk, jwt, …, kept
 * in the sidecar) cuts the chain: the importer gives its inheriting children
 * `none`, and they must re-export WITHOUT `auth` so Postman signs them with
 * the container's auth again.
 */
function authForChildren(
  node: Collection | CollectionItem,
  inherited: AuthConfig | undefined
): AuthConfig | undefined {
  if (hasUnsupportedPostmanAuth(node)) return { type: 'none' };
  // An explicit-noauth container: its inheriting children inherit that noauth.
  if (isExplicitNoauth(node.auth, getPostmanSidecar(node))) return { type: 'none' };
  return isConfiguredAuth(node.auth) ? node.auth : inherited;
}

function exportItem(
  item: CollectionItem,
  inherited: AuthConfig | undefined,
  ctx: ExportContext
): Raw | null {
  const sidecar = getPostmanSidecar(item);
  const placeholder = placeholderItem(item, sidecar, ctx);
  if (placeholder) return placeholder;
  if (item.type === 'request') return exportRequest(item, inherited, sidecar, ctx);
  const name = item.name || 'Untitled';
  if (item.variables?.length) ctx.report.dropped('folder-variables', name);
  if (item.contractSpec) ctx.report.dropped('contract-spec', name);
  const childAuth = authForChildren(item, inherited);
  const items = (item.items ?? [])
    .map((child) => exportItem(child, childAuth, ctx))
    .filter((x): x is Raw => x !== null);
  return defined({
    name,
    $kind: 'collection',
    description: typeof sidecar?.description === 'string' ? sidecar.description : undefined,
    auth: containerAuth(item.auth, sidecar, name, ctx, false),
    scripts: exportScripts(item.preRequestScript, item.testScript, sidecar, COLLECTION_PHASES, ctx),
    items,
  });
}

/** Build the v3 logical tree for `collection` (+ report). */
export function exportPostmanV3Tree(
  collection: Collection,
  options: PostmanV3ExportOptions = {}
): { tree: Raw; report: PostmanExportReport } {
  const report = new PostmanExportReportBuilder();
  const ctx: ExportContext = {
    report,
    transformScript: options.transformScript ?? defaultExportScript,
  };
  const sidecar = getPostmanSidecar(collection);
  const name = collection.name || 'Untitled Collection';
  if (collection.contractSpec) report.dropped('contract-spec', name);
  const items = collection.items
    .map((item) => exportItem(item, authForChildren(collection, collection.auth), ctx))
    .filter((x): x is Raw => x !== null);
  const uses = isObj(sidecar?.uses) ? sidecar.uses : undefined;
  const tree = defined({
    $kind: 'collection',
    name,
    description: collection.description || undefined,
    variables: exportVariables(collection.variables, sidecar, name, ctx),
    scripts: exportScripts(
      collection.preRequestScript,
      collection.testScript,
      sidecar,
      COLLECTION_PHASES,
      ctx
    ),
    auth: containerAuth(collection.auth, sidecar, name, ctx, true),
    uses,
    items: items.length > 0 ? items : undefined,
  });
  return { tree, report: report.build() };
}

/** Restura collection → v3 logical tree + on-disk file map + export report. */
export function exportPostmanV3(
  collection: Collection,
  options: PostmanV3ExportOptions = {}
): PostmanV3Export {
  const { tree, report } = exportPostmanV3Tree(collection, options);
  return { tree, files: writePostmanV3Files(tree), report };
}

export { safeFileName as postmanV3SafeFileName } from './export-v3-files';
