import type { AuthConfig, Collection, CollectionItem, HttpRequest } from '../../types';
import { arr, hasUnsupportedPostmanAuth, isObj } from './common';
import { type PostmanExportReport, PostmanExportReportBuilder } from './export-report';
import {
  AUTH_CUT,
  type V21Inherited,
  v21AuthForChildren,
  v21ContainerAuth,
  v21RequestAuth,
} from './export-v2-auth';
import {
  compact,
  keptProtocolProfile,
  v21Body,
  v21Events,
  v21Headers,
  v21ProtocolProfile,
  v21Url,
  v21Variables,
} from './export-v2-parts';
import { defaultExportScript, type ExportContext } from './export-v3-shared';
import { getPostmanSidecar, type PostmanSidecar } from './sidecar';
import type {
  PostmanV21Collection,
  PostmanV21Item,
  PostmanV21ItemGroup,
  PostmanV21Response,
} from './v21-types';

/**
 * Runtime-neutral Postman Collection v2.1 export (#1229, ADR 0034) — the
 * single-file JSON Newman runs. Same contract as v3 export (`export-v3.ts`):
 *
 * - Output is typed against the generated `PostmanV21Collection`
 *   (`v21-types.ts`) and valid against `vendor/postman/v2.1.0/schema.json`.
 * - Secrets: callers apply the export "include secrets" choice
 *   (`redactCollectionSecrets`) BEFORE calling this, so typed fields and the
 *   `_postman` sidecar are already redacted. On top of that, secret variables
 *   and keychain-handle / external values are always written EMPTY (and
 *   reported).
 * - The `_postman` sidecar is read to restore what the importer could not
 *   model (saved responses, protocolProfileBehavior, shadowed events,
 *   unsupported auth, item / URL variables, file paths, original methods), so
 *   a v2.1 import → export → import round-trips. A configured Restura auth
 *   always wins over sidecar auth. The sidecar is never written as-is.
 * - What v2.1 cannot hold (non-HTTP requests, WSSE, jwt / asap auth,
 *   Restura-only settings, …) is dropped or approximated and listed in the
 *   structured export report (`export-report.ts`, `targetVersion: '2.1'`).
 */

export const POSTMAN_V21_SCHEMA_URL =
  'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

export interface PostmanV21ExportOptions {
  /** Applied to every script (default: the `rs.*` → `pm.*` migration). */
  transformScript?: (script: string) => string;
}

export interface PostmanV21Export {
  collection: PostmanV21Collection;
  report: PostmanExportReport;
}

/** Saved response as Postman writes it (`name` / preview language are outside the schema's property list but allowed). */
type SavedResponse = PostmanV21Response & { name?: string; _postman_previewlanguage?: string };

const RESPONSE_KEYS = [
  'id',
  'name',
  'originalRequest',
  'responseTime',
  'timings',
  'header',
  'cookie',
  'body',
  'status',
  'code',
  '_postman_previewlanguage',
] as const;

/** Sidecar `response[]` (already redacted) → v2.1 saved responses. */
function savedResponses(sidecar: PostmanSidecar | undefined): SavedResponse[] | undefined {
  const out = arr(sidecar?.response)
    .filter(isObj)
    .map((r) => {
      const picked: Record<string, unknown> = {};
      for (const k of RESPONSE_KEYS) if (r[k] !== undefined) picked[k] = r[k];
      return picked as SavedResponse;
    });
  return out.length > 0 ? out : undefined;
}

function exportHttpItem(
  req: HttpRequest,
  name: string,
  inherited: V21Inherited,
  sidecar: PostmanSidecar | undefined,
  ctx: ExportContext
): PostmanV21Item {
  if (req.graphqlSchema || req.graphqlSubscriptionProtocol) {
    ctx.report.dropped('graphql-extras', name);
  }
  // An unsendable method imported as GET: restore the original.
  const method =
    typeof sidecar?.method === 'string' && req.method === 'GET' ? sidecar.method : req.method;
  const request = compact({
    method,
    header: v21Headers(req.headers, name, ctx),
    url: v21Url(req, sidecar, name, ctx),
    body: v21Body(req, sidecar, name, ctx),
    auth: v21RequestAuth(req.auth, inherited, sidecar, name, ctx),
    description: req.description || undefined,
  });
  return compact({
    name,
    variable: v21Variables(undefined, sidecar, name, ctx),
    event: v21Events(req.preRequestScript, req.testScript, sidecar, ctx),
    request,
    response: savedResponses(sidecar),
    protocolProfileBehavior: v21ProtocolProfile(req.settings, sidecar, name, ctx),
  });
}

/** Placeholder folder created at v3 import for an item kind Restura cannot model. */
function isPlaceholder(item: CollectionItem, sidecar: PostmanSidecar | undefined): boolean {
  if (item.type !== 'folder' || (item.items?.length ?? 0) > 0) return false;
  const raw = sidecar?.item;
  return isObj(raw) && typeof raw.$kind === 'string' && raw.$kind !== 'collection';
}

function exportItem(
  item: CollectionItem,
  inherited: V21Inherited,
  ctx: ExportContext
): PostmanV21Item | PostmanV21ItemGroup | null {
  const sidecar = getPostmanSidecar(item);
  const name = item.name || item.request?.name || 'Untitled';
  if (isPlaceholder(item, sidecar)) {
    ctx.report.dropped(
      'placeholder-item',
      name,
      String((sidecar?.item as { $kind: string }).$kind)
    );
    return null;
  }
  if (item.type === 'request') {
    const req = item.request;
    if (!req) return null;
    if (req.type !== 'http') {
      ctx.report.dropped('non-http-request', name, req.type);
      return null;
    }
    return exportHttpItem(req, name, inherited, sidecar, ctx);
  }
  if (item.contractSpec) ctx.report.dropped('contract-spec', name);
  const childAuth = v21AuthForChildren(item, hasUnsupportedPostmanAuth(item), inherited);
  const children = (item.items ?? [])
    .map((child) => exportItem(child, childAuth, ctx))
    .filter((x): x is PostmanV21Item | PostmanV21ItemGroup => x !== null);
  return compact({
    name,
    description: typeof sidecar?.description === 'string' ? sidecar.description : undefined,
    variable: v21Variables(item.variables, sidecar, name, ctx),
    item: children,
    event: v21Events(item.preRequestScript, item.testScript, sidecar, ctx),
    auth: v21ContainerAuth(item.auth, sidecar, name, ctx, false),
    protocolProfileBehavior: keptProtocolProfile(sidecar),
  });
}

/** Restura collection → Postman v2.1 collection JSON + export report. */
export function exportPostmanV21(
  collection: Collection,
  options: PostmanV21ExportOptions = {}
): PostmanV21Export {
  const report = new PostmanExportReportBuilder();
  const ctx: ExportContext = {
    report,
    transformScript: options.transformScript ?? defaultExportScript,
  };
  const sidecar = getPostmanSidecar(collection);
  const name = collection.name || 'Untitled Collection';
  if (collection.contractSpec) report.dropped('contract-spec', name);
  const rootAuth: AuthConfig | undefined = collection.auth;
  const childAuth = v21AuthForChildren(collection, hasUnsupportedPostmanAuth(collection), rootAuth);
  const items = collection.items
    .map((item) => exportItem(item, childAuth === AUTH_CUT ? AUTH_CUT : childAuth, ctx))
    .filter((x): x is PostmanV21Item | PostmanV21ItemGroup => x !== null);
  const out: PostmanV21Collection = compact({
    info: compact({
      name,
      description: collection.description || undefined,
      schema: POSTMAN_V21_SCHEMA_URL,
    }),
    item: items,
    event: v21Events(collection.preRequestScript, collection.testScript, sidecar, ctx),
    variable: v21Variables(collection.variables, undefined, name, ctx),
    auth: v21ContainerAuth(collection.auth, sidecar, name, ctx, true),
    protocolProfileBehavior: keptProtocolProfile(sidecar),
  });
  return { collection: out, report: report.build('2.1') };
}
