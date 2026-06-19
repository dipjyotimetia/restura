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
import { authToInternal, groupScripts } from './to-internal';
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
  // Strategy 1 — whole-collection shortcut. Gated on three kinds of freshness:
  //  - bag presence (allItemsHaveOcBag): an edited/added item drops its bag,
  //    and `useCollectionStore` strips the `_oc` bag of every ancestor folder
  //    on edit/add/remove/move — so any nested change defeats this.
  //  - auth (authUnchanged / allFolderAuthsUnchanged): default auth lives on the
  //    root/folder bags, so an in-app auth edit must defeat the shortcut.
  //  - root structure (rootStructureUnchanged): a ROOT-level removal strips no
  //    bag (the store's ancestorPath is empty at root) and every survivor keeps
  //    its bag, so only a root count reconciliation sees the deletion. Without
  //    it the cached document re-emits the removed item (GH #278). Nested
  //    removals are already covered by the ancestor-strip above, so no folder
  //    structural check is needed here.
  //  - scripts (scriptsUnchanged / allFolderScriptsUnchanged): collection/folder
  //    pre-request/test scripts live on the root/folder bags, so an in-app
  //    script edit must defeat the shortcut — gated independently of auth so a
  //    script-only edit never recomputes un-modellable auth.
  if (
    c._oc &&
    allItemsHaveOcBag(c.items) &&
    authUnchanged(c._oc, c.auth) &&
    allFolderAuthsUnchanged(c.items) &&
    rootStructureUnchanged(c) &&
    scriptsUnchanged(c._oc, c.preRequestScript, c.testScript) &&
    allFolderScriptsUnchanged(c.items)
  ) {
    return c._oc as OpenCollection;
  }

  const sseItems: unknown[] = [];
  const mcpItems: unknown[] = [];
  const items: unknown[] = [];

  for (const it of c.items ?? []) {
    const wit = it as WithOC<CollectionItem>;
    if (it.type === 'folder') {
      items.push(folderFromInternal(wit, sseItems, mcpItems));
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
    // Collection-level scripts: same treatment, gated independently so a
    // script-only edit never recomputes auth (preserves un-modellable types).
    if (!scriptsUnchanged(cached, c.preRequestScript, c.testScript)) {
      applyRequestDefaultsScripts(oc as Record<string, unknown>, c.preRequestScript, c.testScript);
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
  const rootScripts = buildScripts(c.preRequestScript, c.testScript);
  if (rootAuth || rootScripts) {
    oc.request = {
      ...(rootAuth ? { auth: rootAuth } : {}),
      ...(rootScripts ? { scripts: rootScripts } : {}),
    };
  }

  const extensions: Record<string, unknown> = {};
  if (sseItems.length > 0) extensions['x-restura-sse'] = sseItems;
  if (mcpItems.length > 0) extensions['x-restura-mcp'] = mcpItems;
  if (Object.keys(extensions).length > 0) oc.extensions = extensions;

  if ((c.variables ?? []).length > 0) {
    oc.config = {
      environments: [
        {
          name: 'default',
          variables: (c.variables ?? []).map((v) => {
            const common: { description?: string; disabled?: boolean } = {};
            if (v.description) common.description = v.description;
            if (v.enabled === false) common.disabled = true;
            // Secret-flagged variables emit as the spec `secretVariable` shape
            // — name only, no value — so a credential stashed in a collection
            // variable never lands in the shared/committed file; the recipient
            // fills the value in. (Structural: holds for both "redacted" and
            // "include secrets" exports.)
            return v.secret
              ? { secret: true as const, name: v.key, ...common }
              : { name: v.key, value: v.value, ...common };
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
 * Set or clear a single key in a node's OC `request` (RequestDefaults) bag,
 * preserving every other default the bag carried and dropping the bag entirely
 * when the result would be empty (so the YAML stays compact). `fresh ===
 * undefined` clears the key. Shared by the auth and scripts appliers — they are
 * gated independently at the call sites, so this never recomputes one from the
 * other (load-bearing for un-modellable auth, see callers).
 */
function setRequestDefault(node: Record<string, unknown>, key: string, fresh: unknown): void {
  const cachedRequest =
    node.request && typeof node.request === 'object'
      ? { ...(node.request as Record<string, unknown>) }
      : {};
  if (fresh !== undefined) {
    node.request = { ...cachedRequest, [key]: fresh };
    return;
  }
  delete cachedRequest[key];
  if (Object.keys(cachedRequest).length > 0) node.request = cachedRequest;
  else delete node.request;
}

/** Merge a node's internal auth into its OC `request` (RequestDefaults) bag. */
function applyRequestDefaultsAuth(
  node: Record<string, unknown>,
  auth: AuthConfig | undefined
): void {
  setRequestDefault(node, 'auth', authFromInternal(auth));
}

/**
 * Merge a node's internal pre-request / test scripts into its `request` bag.
 * Only the `before-request` / `tests` entries are rebuilt from the internal
 * fields; every other cached script entry (`after-response`, `hooks`, file-ref
 * scripts) is preserved verbatim. Without this, a script-only edit would rewrite
 * the whole `scripts` array and silently drop those un-modellable entries — the
 * script analogue of the un-modellable-auth trap (see {@link authUnchanged}).
 */
function applyRequestDefaultsScripts(
  node: Record<string, unknown>,
  preRequest: string | undefined,
  test: string | undefined
): void {
  const cached = (node.request as { scripts?: unknown } | undefined)?.scripts;
  const preserved = Array.isArray(cached)
    ? cached.filter((s) => {
        const t = (s as { type?: unknown } | null)?.type;
        return t !== 'before-request' && t !== 'tests';
      })
    : [];
  const fresh = buildScripts(preRequest, test) ?? [];
  const merged = [...fresh, ...preserved];
  setRequestDefault(node, 'scripts', merged.length > 0 ? merged : undefined);
}

function folderFromInternal(
  it: WithOC<CollectionItem>,
  sseItems: unknown[],
  mcpItems: unknown[]
): unknown {
  // Verbatim shortcut only while the folder's default auth AND scripts still
  // match the cached bag — an in-app edit to either forces a rebuild (children
  // still fall back to their own _oc bags below, so unmodified requests stay
  // verbatim).
  const authSame = authUnchanged(it._oc, it.auth);
  const scriptsSame = scriptsUnchanged(it._oc, it.preRequestScript, it.testScript);
  if (it._oc && authSame && scriptsSame) return it._oc;
  const out: Record<string, unknown> = it._oc
    ? { ...(it._oc as Record<string, unknown>) }
    : { info: { name: it.name } };
  const childItems: unknown[] = [];
  for (const child of it.items ?? []) {
    const wchild = child as WithOC<CollectionItem>;
    if (child.type === 'folder') {
      childItems.push(folderFromInternal(wchild, sseItems, mcpItems));
      continue;
    }
    const r = child.request;
    if (!r) {
      childItems.push(wchild._oc ?? { info: { name: child.name } });
      continue;
    }
    // SSE / MCP aren't valid folder items in OpenCollection — they live in
    // root `extensions`. Hoist a folder-nested one rather than throwing (a
    // user can drag an SSE/MCP request into a folder). Folder grouping isn't
    // representable in the extension model, so it lands at the root, matching
    // how root-level SSE/MCP are emitted.
    if (r.type === 'sse') {
      sseItems.push(wchild._oc ?? sseToOC(child.name, r as SseRequest));
      continue;
    }
    if (r.type === 'mcp') {
      mcpItems.push(wchild._oc ?? mcpToOC(child.name, r as McpRequest));
      continue;
    }
    childItems.push(wchild._oc ?? requestFromInternal(child.name, r));
  }
  out.items = childItems;
  // Apply each independently and only when it actually changed: rebuilding for
  // a script edit must not recompute auth (would drop OAuth1/NTLM/WSSE, which
  // survive only via the cached _oc bytes), and vice versa.
  if (!authSame) applyRequestDefaultsAuth(out, it.auth);
  if (!scriptsSame) applyRequestDefaultsScripts(out, it.preRequestScript, it.testScript);
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
        http.headers = hr.headers.map(kvFromInternal);
      }
      if (hr.params?.length) {
        http.params = hr.params.map(kvFromInternal);
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
        grpc.metadata = gr.metadata.map(kvFromInternal);
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
    sse.headers = r.headers.map(kvFromInternal);
  }
  if (r.eventFilter?.length) sse.eventFilter = r.eventFilter;
  const auth = authFromInternal(r.auth);
  if (auth) sse.auth = auth;
  return { info: { type: 'sse', name }, sse };
}

function mcpToOC(name: string, r: McpRequest): unknown {
  const mcp: Record<string, unknown> = { url: r.url, transport: r.transport };
  if (r.headers?.length) {
    mcp.headers = r.headers.map(kvFromInternal);
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
  // Emit `enabled: false` so a disabled header/param/metadata round-trips as
  // disabled rather than vanishing on re-import. (The OC httpHeader/httpParam
  // schema carries `enabled`, defaulting to true.)
  if (k.enabled === false) out.enabled = false;
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
    case 'binary': {
      if (!body.binary) return undefined;
      // A live DOM `File` is not YAML-serializable — dumping it throws and
      // takes the whole export down. Emit a portable descriptor (name + MIME)
      // instead so the export never crashes. The raw bytes aren't carried in
      // the shared text document by design.
      const f = body.binary;
      if (typeof File !== 'undefined' && f instanceof File) {
        return { file: { name: f.name, ...(f.type ? { contentType: f.type } : {}) } };
      }
      return { file: f };
    }
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
 *
 * Known blind spot: auth types with no internal representation (OAuth1/NTLM/
 * WSSE) degrade to 'none' through authToInternal, so cached-vs-current
 * compares none === none and the gate reports "unchanged" no matter what.
 * Untouched documents round-trip byte-stably (desired), but clearing such an
 * auth in-app resurrects the original block on an include-secrets export.
 * Redacted exports are NOT affected — redactCollectionSecrets drops the root
 * `_oc` bag outright, so this tier always rebuilds there. The real fix is
 * native internal support for these types (Phase 4); a treat-degraded-as-
 * changed heuristic would instead drop their auth on every round-trip.
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
 * Root-level structural staleness check (GH #278). `allItemsHaveOcBag` only sees
 * bag *presence*, so a root-level removal — where every survivor keeps its bag
 * and the store strips nothing (ancestorPath is empty at the root) — slips past
 * it and the cached document re-emits the deleted item. A count reconciliation
 * catches it. The root carries the sse/mcp ↔ extensions asymmetry: sse/mcp
 * requests live in `c.items` internally but under
 * `extensions['x-restura-sse'|'x-restura-mcp']` in `c._oc` (NOT `c._oc.items`),
 * so the two partitions reconcile separately. Opaque extensions
 * (x-restura-socketio/kafka/mqtt) have no live counterpart and are not counted.
 * Count is sufficient: adds are already caught by `allItemsHaveOcBag` (the new
 * item lacks a bag); only a removal strictly drops the count. Nested removals
 * are handled by ancestor `_oc`-stripping in the store, so this stays root-only.
 */
function rootStructureUnchanged(c: WithOC<Collection>): boolean {
  const cached = c._oc as OpenCollection | undefined;
  if (!cached) return true;
  const live = c.items ?? [];
  const liveStream = live.filter(
    (it) => it.type === 'request' && (it.request?.type === 'sse' || it.request?.type === 'mcp')
  ).length;
  const liveNonStream = live.length - liveStream;
  const ext = (cached.extensions ?? {}) as Record<string, unknown>;
  const cachedSse = (ext['x-restura-sse'] as unknown[] | undefined)?.length ?? 0;
  const cachedMcp = (ext['x-restura-mcp'] as unknown[] | undefined)?.length ?? 0;
  return liveNonStream === (cached.items ?? []).length && liveStream === cachedSse + cachedMcp;
}

/**
 * Export-time staleness check for collection/folder scripts, mirroring
 * {@link authUnchanged}. Converts the cached `_oc` bag's `request.scripts`
 * through the SAME import grouping (`groupScripts`) and compares the resulting
 * pre/test strings against the current internal fields. Equal → cached bytes
 * are still true (emit verbatim); different → scripts were edited in-app and
 * the cached doc must be rebuilt. `groupScripts` is side-effect-free, so this
 * never touches the import-time unrecognized-script counters.
 */
function scriptsUnchanged(
  cachedNode: unknown,
  preRequest: string | undefined,
  test: string | undefined
): boolean {
  const cachedRequest = (cachedNode as { request?: unknown } | undefined)?.request;
  const cached = groupScripts((cachedRequest as { scripts?: unknown } | undefined)?.scripts);
  return (cached.preRequest ?? '') === (preRequest ?? '') && (cached.test ?? '') === (test ?? '');
}

/** Recursively true when every folder's scripts still match its cached bag. */
function allFolderScriptsUnchanged(items: CollectionItem[] | undefined): boolean {
  if (!items) return true;
  return items.every((it) => {
    if (it.type !== 'folder') return true;
    const wit = it as WithOC<CollectionItem>;
    if (wit._oc !== undefined && !scriptsUnchanged(wit._oc, it.preRequestScript, it.testScript)) {
      return false;
    }
    return allFolderScriptsUnchanged(it.items);
  });
}

/**
 * Build an OpenCollection `Script[]` from the internal preRequestScript /
 * testScript fields. Returns undefined when neither is set so callers can omit
 * the container (request `runtime` or collection/folder `request.scripts`)
 * entirely and keep the YAML compact.
 */
function buildScripts(
  preRequest?: string,
  test?: string
): Array<{ type: string; code: string }> | undefined {
  const scripts: Array<{ type: string; code: string }> = [];
  if (preRequest && preRequest.trim().length > 0) {
    scripts.push({ type: 'before-request', code: preRequest });
  }
  if (test && test.trim().length > 0) {
    scripts.push({ type: 'tests', code: test });
  }
  return scripts.length === 0 ? undefined : scripts;
}

/**
 * Build a request-level `runtime` object with `scripts: Script[]` from the
 * internal preRequestScript / testScript fields. Returns undefined if neither
 * is set, so the caller can omit the `runtime` key entirely.
 */
function runtimeFromInternal(
  preRequest?: string,
  test?: string
): Record<string, unknown> | undefined {
  const scripts = buildScripts(preRequest, test);
  return scripts ? { scripts } : undefined;
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
