import type {
  Collection,
  CollectionItem,
  Request,
  HttpRequest,
  GrpcRequest,
  SseRequest,
  McpRequest,
  AuthConfig,
  KeyValue,
  RequestBody,
  GrpcMethodType,
} from '@/types';
import type { SecretValue } from '@/lib/shared/secretRef';
import { SECRET_FIELDS_BY_AUTH_BLOCK } from '@/lib/shared/auth-secret-fields';
import { authToInternal } from './to-internal';
import type { OpenCollection } from './schemas';

/**
 * Bridge from Restura internal `Collection` (and its `_oc` passthrough bags) →
 * OpenCollection (v1.0.0). Inverse of `to-internal.ts`.
 *
 * Strategy is layered for diff-friendliness:
 *
 *   1. **Whole-collection shortcut.** If every level still has its `_oc` bag
 *      AND the collection itself has `_oc` (i.e. nothing was edited),
 *      return the cached OC verbatim. Byte-identical to the input.
 *   2. **Root-preserving rebuild.** If the collection has `_oc` but some
 *      items were edited, the rebuild starts from the cached root (so
 *      `info` extras, `config` extras, `docs`, request defaults, and any
 *      non-restura extensions survive) and only the `items` array plus
 *      Restura-managed extensions (`x-restura-sse` / `x-restura-mcp`) get
 *      replaced with fresh values. Unknown extensions like
 *      `x-restura-socketio` survive unchanged because the merge keeps every
 *      non-restura-managed key from the cached extensions bag.
 *   3. **Synthesise from scratch.** No `_oc` on the collection — likely
 *      authored in-app rather than imported. Build a minimal OC document
 *      from the internal model alone.
 *
 * Per-item, every emitter falls back to `wit._oc ?? rebuild()` so unmodified
 * items always emit verbatim regardless of which strategy fires above.
 *
 * Special cases mirroring `to-internal.ts`:
 *   - Internal HttpRequest with `body.type === 'graphql'` originated from an
 *     OC graphql item. Without `_oc` we cannot recover the original GraphQL
 *     OC representation, so we emit it as a plain HTTP item — that's the
 *     trade-off documented in Phase 0.
 *   - SSE / MCP requests do not live in the OC `items` array; they go into
 *     `extensions['x-restura-sse']` / `extensions['x-restura-mcp']`.
 *   - WebSocket placeholders survive only via `_oc` bags on folder items.
 *   - Auth name conversions: internal `api-key`/`aws-signature` ↔ OC
 *     `apikey`/`awsv4`.
 *   - Method type conversions: internal hyphenated ↔ OC camelCase.
 */

type WithOC<T> = T & { _oc?: unknown };

export function internalToOC(c: WithOC<Collection>): OpenCollection {
  // Strategy 1 — whole-collection shortcut. Gated on auth freshness too:
  // collection/folder default auth lives on the root/folder bags, so an
  // in-app auth edit must defeat the verbatim shortcut or the export would
  // carry the stale credentials shape.
  if (
    c._oc &&
    allItemsHaveOcBag(c.items) &&
    authUnchanged(c._oc, c.auth) &&
    allFolderAuthsUnchanged(c.items)
  ) {
    return c._oc as OpenCollection;
  }

  const sseItems: unknown[] = [];
  const mcpItems: unknown[] = [];
  const items: unknown[] = [];

  for (const it of c.items ?? []) {
    const wit = it as WithOC<CollectionItem>;
    if (it.type === 'folder') {
      items.push(folderFromInternal(wit));
      continue;
    }
    const r = it.request;
    if (!r) continue;

    if (r.type === 'sse') {
      sseItems.push(wit._oc ?? sseToOC(it.name, r as SseRequest));
      continue;
    }
    if (r.type === 'mcp') {
      mcpItems.push(wit._oc ?? mcpToOC(it.name, r as McpRequest));
      continue;
    }
    items.push(wit._oc ?? requestFromInternal(it.name, r));
  }

  // Strategy 2 — root-preserving rebuild. Start from the cached OC root,
  // replace items + Restura-managed extensions only.
  if (c._oc) {
    const cached = c._oc as OpenCollection;
    const oc: OpenCollection = { ...cached, items };

    // Merge extensions: keep non-restura keys from the cache, overwrite the
    // restura-managed ones with fresh arrays (or remove if empty so the YAML
    // stays compact).
    const cachedExt = (cached.extensions ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...cachedExt };
    delete merged['x-restura-sse'];
    delete merged['x-restura-mcp'];
    if (sseItems.length > 0) merged['x-restura-sse'] = sseItems;
    if (mcpItems.length > 0) merged['x-restura-mcp'] = mcpItems;
    if (Object.keys(merged).length > 0) oc.extensions = merged;
    else delete oc.extensions;

    // Collection-level default auth: keep the cached `request` bag verbatim
    // when the auth is unchanged (byte-stable); otherwise merge the fresh
    // auth over it so an in-app edit reaches the export.
    if (!authUnchanged(cached, c.auth)) {
      applyRequestDefaultsAuth(oc as Record<string, unknown>, c.auth);
    }

    return oc;
  }

  // Strategy 3 — synthesise from scratch.
  const oc: OpenCollection = {
    opencollection: '1.0.0',
    info: {
      name: c.name,
      ...(c.description ? { summary: c.description } : {}),
    },
    items,
  };

  const rootAuth = authFromInternal(c.auth);
  if (rootAuth) oc.request = { auth: rootAuth };

  const extensions: Record<string, unknown> = {};
  if (sseItems.length > 0) extensions['x-restura-sse'] = sseItems;
  if (mcpItems.length > 0) extensions['x-restura-mcp'] = mcpItems;
  if (Object.keys(extensions).length > 0) oc.extensions = extensions;

  if ((c.variables ?? []).length > 0) {
    oc.config = {
      environments: [
        {
          name: 'default',
          variables: (c.variables ?? [])
            .filter((v) => v.enabled !== false)
            .map((v) => {
              const variable: { name: string; value: string; description?: string } = {
                name: v.key,
                value: v.value,
              };
              if (v.description) variable.description = v.description;
              return variable;
            }),
        },
      ],
    };
  }

  return oc;
}

function allItemsHaveOcBag(items: CollectionItem[] | undefined): boolean {
  if (!items) return true;
  return items.every((it) => {
    const wit = it as WithOC<CollectionItem>;
    if (wit._oc === undefined) return false;
    if (it.type === 'folder') return allItemsHaveOcBag(it.items);
    return true;
  });
}

/**
 * Merge a node's internal auth into its OC `request` (RequestDefaults) bag,
 * preserving any other defaults the bag carried. Removes the bag entirely
 * when the result would be empty so the YAML stays compact.
 */
function applyRequestDefaultsAuth(
  node: Record<string, unknown>,
  auth: AuthConfig | undefined
): void {
  const fresh = authFromInternal(auth);
  const cachedRequest =
    node.request && typeof node.request === 'object'
      ? { ...(node.request as Record<string, unknown>) }
      : {};
  if (fresh) {
    node.request = { ...cachedRequest, auth: fresh };
    return;
  }
  delete cachedRequest.auth;
  if (Object.keys(cachedRequest).length > 0) node.request = cachedRequest;
  else delete node.request;
}

function folderFromInternal(it: WithOC<CollectionItem>): unknown {
  // Verbatim shortcut only while the folder's default auth still matches the
  // cached bag — an in-app auth edit forces a rebuild (children still fall
  // back to their own _oc bags below, so unmodified requests stay verbatim).
  if (it._oc && authUnchanged(it._oc, it.auth)) return it._oc;
  const out: Record<string, unknown> = it._oc
    ? { ...(it._oc as Record<string, unknown>) }
    : { info: { name: it.name } };
  out.items = (it.items ?? []).map((child) => {
    const wchild = child as WithOC<CollectionItem>;
    if (child.type === 'folder') return folderFromInternal(wchild);
    if (!child.request) return wchild._oc ?? { info: { name: child.name } };
    return wchild._oc ?? requestFromInternal(child.name, child.request);
  });
  applyRequestDefaultsAuth(out, it.auth);
  return out;
}

function requestFromInternal(name: string, r: Request): unknown {
  switch (r.type) {
    case 'http': {
      const hr = r as HttpRequest;
      const http: Record<string, unknown> = {
        method: hr.method,
        url: hr.url,
      };
      if (hr.headers?.length) {
        http.headers = hr.headers.filter((h) => h.enabled !== false).map(kvFromInternal);
      }
      if (hr.params?.length) {
        http.params = hr.params.filter((p) => p.enabled !== false).map(kvFromInternal);
      }
      if (hr.body && hr.body.type !== 'none') {
        const body = bodyFromInternal(hr.body);
        if (body !== undefined) http.body = body;
      }
      const auth = authFromInternal(hr.auth);
      if (auth) http.auth = auth;
      const out: Record<string, unknown> = { info: { type: 'http', name }, http };
      const runtime = runtimeFromInternal(hr.preRequestScript, hr.testScript);
      if (runtime) out.runtime = runtime;
      return out;
    }
    case 'grpc': {
      const gr = r as GrpcRequest;
      const grpc: Record<string, unknown> = {
        url: gr.url,
        service: gr.service,
        method: gr.method,
        methodType: methodTypeFromInternal(gr.methodType),
      };
      if (gr.message) grpc.message = gr.message;
      if (gr.metadata?.length) {
        grpc.metadata = gr.metadata.filter((m) => m.enabled !== false).map(kvFromInternal);
      }
      const auth = authFromInternal(gr.auth);
      if (auth) grpc.auth = auth;
      const out: Record<string, unknown> = { info: { type: 'grpc', name }, grpc };
      const runtime = runtimeFromInternal(gr.preRequestScript, gr.testScript);
      if (runtime) out.runtime = runtime;
      return out;
    }
    case 'sse':
    case 'mcp':
      // SSE / MCP must be routed into extensions by the caller.
      throw new Error(
        `internalToOC: SSE/MCP requests must be emitted via extensions, not requestFromInternal`
      );
  }
}

function sseToOC(name: string, r: SseRequest): unknown {
  const sse: Record<string, unknown> = { url: r.url };
  if (r.headers?.length) {
    sse.headers = r.headers.filter((h) => h.enabled !== false).map(kvFromInternal);
  }
  if (r.eventFilter?.length) sse.eventFilter = r.eventFilter;
  const auth = authFromInternal(r.auth);
  if (auth) sse.auth = auth;
  return { info: { type: 'sse', name }, sse };
}

function mcpToOC(name: string, r: McpRequest): unknown {
  const mcp: Record<string, unknown> = { url: r.url, transport: r.transport };
  if (r.headers?.length) {
    mcp.headers = r.headers.filter((h) => h.enabled !== false).map(kvFromInternal);
  }
  const auth = authFromInternal(r.auth);
  if (auth) mcp.auth = auth;
  return { info: { type: 'mcp', name }, mcp };
}

function kvFromInternal(k: KeyValue): unknown {
  const out: Record<string, unknown> = {
    name: k.key,
    value: k.value,
  };
  if (k.description) out.description = k.description;
  return out;
}

function bodyFromInternal(body: RequestBody): unknown {
  switch (body.type) {
    case 'json':
      return { raw: { format: 'json', value: body.raw ?? '' } };
    case 'xml':
      return { raw: { format: 'xml', value: body.raw ?? '' } };
    case 'text':
      return { raw: { format: 'text', value: body.raw ?? '' } };
    case 'graphql':
      // Without _oc, the only safe representation is JSON-encoded raw.
      return { raw: { format: 'json', value: body.raw ?? '' } };
    case 'form-data':
      return { multipartForm: { parts: body.formData ?? [] } };
    case 'x-www-form-urlencoded':
      return { formUrlEncoded: { parts: body.formData ?? [] } };
    case 'binary':
      return body.binary ? { file: body.binary } : undefined;
    default:
      return undefined;
  }
}

/**
 * Render a SecretValue for the OC text format. Inline values become plaintext
 * (the document is a portable file; redaction is the export dialog's job),
 * handles become a `{{handle:<label>}}` placeholder — the keychain plaintext
 * never leaves the machine. Mirrors `exportSecretValue` in the Postman/
 * Insomnia exporters. Without this, post-ADR-0007 auth (SecretValue objects)
 * would serialize as `{kind: inline, value: …}` blobs into the YAML.
 */
function secretToString(value: SecretValue | undefined): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value.kind === 'inline') return value.value;
  return `{{handle:${value.label ?? value.id}}}`;
}

/** oauth2 fields that hold SecretValues and need unwrapping on export. */
const OAUTH2_SECRET_FIELDS = new Set(['accessToken', 'refreshToken', 'clientSecret', 'password']);

function authFromInternal(a?: AuthConfig): unknown {
  if (!a || a.type === 'none') return undefined;
  switch (a.type) {
    case 'basic':
      return {
        type: 'basic',
        username: a.basic?.username ?? '',
        password: secretToString(a.basic?.password),
      };
    case 'bearer':
      return { type: 'bearer', token: secretToString(a.bearer?.token) };
    case 'api-key':
      return {
        type: 'apikey',
        key: a.apiKey?.key ?? '',
        value: secretToString(a.apiKey?.value),
        placement: a.apiKey?.in ?? 'header',
      };
    case 'aws-signature':
      return {
        type: 'awsv4',
        accessKeyId: a.awsSignature?.accessKey ?? '',
        secretAccessKey: secretToString(a.awsSignature?.secretKey),
        region: a.awsSignature?.region ?? '',
        service: a.awsSignature?.service ?? '',
      };
    case 'digest':
      return {
        type: 'digest',
        username: a.digest?.username ?? '',
        password: secretToString(a.digest?.password),
      };
    case 'oauth2': {
      const out: Record<string, unknown> = { type: 'oauth2' };
      const o = a.oauth2 ?? {};
      for (const [k, v] of Object.entries(o)) {
        if (v === undefined) continue;
        out[k] = OAUTH2_SECRET_FIELDS.has(k) ? secretToString(v as SecretValue) : v;
      }
      return out;
    }
    default:
      return undefined;
  }
}

/**
 * Flatten every SecretValue in an AuthConfig to its exportable string form so
 * both compare-sides live in the same space: cached OC auth holds plain
 * strings, post-ADR-0007 internal auth holds SecretValue objects. (A local
 * walk over the shared field map rather than `migrateAuthConfigToSecretRef`
 * — that module pulls in `platform.ts`, which the CLI tsconfig can't compile.)
 */
function unwrapAuthForCompare(a: AuthConfig): AuthConfig {
  const out = { ...a };
  for (const [block, fields] of Object.entries(SECRET_FIELDS_BY_AUTH_BLOCK)) {
    const cur = out[block as keyof AuthConfig];
    if (!cur || typeof cur !== 'object') continue;
    const copy = { ...cur } as Record<string, unknown>;
    for (const f of fields) {
      if (f in copy) copy[f] = secretToString(copy[f] as SecretValue | undefined);
    }
    (out as unknown as Record<string, unknown>)[block as string] = copy;
  }
  return out;
}

/**
 * Export-time staleness check for collection/folder default auth. The cached
 * `_oc` bag predates any in-app edit, so before trusting it we convert its
 * `request.auth` through the SAME import pipeline (authToInternal) and
 * deep-compare against the current internal auth (secrets flattened to their
 * exportable strings on both sides). Equal → cached bytes are still true;
 * different → the auth was edited in-app and the cached doc must not be
 * emitted verbatim.
 *
 * The JSON comparison is order-sensitive, which is safe by construction: a
 * false "changed" verdict merely costs byte-stability (we rebuild), while
 * false "unchanged" would require structurally different auth to serialize
 * identically — impossible.
 */
function authUnchanged(cachedNode: unknown, internalAuth: AuthConfig | undefined): boolean {
  const cachedRequest = (cachedNode as { request?: unknown } | undefined)?.request;
  const cachedAuth = (cachedRequest as { auth?: unknown } | undefined)?.auth;
  const cachedInternal = unwrapAuthForCompare(authToInternal(cachedAuth));
  const currentInternal = unwrapAuthForCompare(internalAuth ?? { type: 'none' });
  return JSON.stringify(cachedInternal) === JSON.stringify(currentInternal);
}

/** Recursively true when every folder's auth still matches its cached bag. */
function allFolderAuthsUnchanged(items: CollectionItem[] | undefined): boolean {
  if (!items) return true;
  return items.every((it) => {
    if (it.type !== 'folder') return true;
    const wit = it as WithOC<CollectionItem>;
    if (wit._oc !== undefined && !authUnchanged(wit._oc, it.auth)) return false;
    return allFolderAuthsUnchanged(it.items);
  });
}

/**
 * Build a `runtime` object with `scripts: Script[]` from the internal
 * preRequestScript / testScript fields. Returns undefined if neither is set,
 * so the caller can omit the `runtime` key entirely and keep YAML compact.
 */
function runtimeFromInternal(
  preRequest?: string,
  test?: string
): Record<string, unknown> | undefined {
  const scripts: Array<{ type: string; code: string }> = [];
  if (preRequest && preRequest.trim().length > 0) {
    scripts.push({ type: 'before-request', code: preRequest });
  }
  if (test && test.trim().length > 0) {
    scripts.push({ type: 'tests', code: test });
  }
  if (scripts.length === 0) return undefined;
  return { scripts };
}

function methodTypeFromInternal(t: GrpcMethodType): string {
  switch (t) {
    case 'server-streaming':
      return 'serverStreaming';
    case 'client-streaming':
      return 'clientStreaming';
    case 'bidirectional-streaming':
      return 'bidirectional';
    case 'unary':
    default:
      return 'unary';
  }
}
